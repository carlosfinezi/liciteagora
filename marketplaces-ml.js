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

// Reserva e baixa de estoque do pedido de marketplace.
const { criarReservasPedido, cancelarReservasPedido, consumirReservasPedido } = require('./reservas-routes');

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
    sincronizarEstoque: 'INTEGER DEFAULT 0', // Fase 2: push ERP→ML gated (default OFF)
  };
  for (const [c, t] of Object.entries(cols)) { try { db.exec(`ALTER TABLE marketplaces_integracoes ADD COLUMN ${c} ${t}`); } catch {} }
  // Fase 2: mapa anúncio ML ↔ produto local (casa por seller_sku → produtos.sku).
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS ml_item_map (
      mlItemId TEXT PRIMARY KEY, produtoId INTEGER, sku TEXT, titulo TEXT,
      qtdML INTEGER, ultimoPushEm TEXT, atualizadoEm TEXT );`);
  } catch {}
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

// ─── Fase 1: importação de pedidos ───────────────────────────────────────────
// Access token válido do tenant (decifra; renova se faltar <5min). Retorna string ou null.
async function getAccessTokenValido(db, log = () => {}) {
  const row = db.prepare("SELECT accessTokenEnc, refreshTokenEnc, expiresAt FROM marketplaces_integracoes WHERE canal='mercado-livre' AND ativo=1").get();
  if (!row || !row.accessTokenEnc) return null;
  if (Number(row.expiresAt || 0) - Date.now() > 5 * 60 * 1000) return decifrar(row.accessTokenEnc);
  const refresh = decifrar(row.refreshTokenEnc);
  if (refresh) {
    const r = await refreshAccessToken(refresh);
    if (r.ok && r.json?.access_token) { gravarTokens(db, r.json, null); return r.json.access_token; }
    log('[ML] refresh falhou em getAccessTokenValido: ' + r.status);
  }
  return decifrar(row.accessTokenEnc); // fallback ao atual (pode já ter expirado)
}
async function mlGet(accessToken, apiPath) {
  const r = await fetch(`${API_BASE}${apiPath}`, { headers: { Authorization: `Bearer ${accessToken}` } });
  return { ok: r.ok, status: r.status, json: r.ok ? await r.json().catch(() => null) : null };
}

// Descobre qual tenant é dono de um mlUserId (varre os tenants — baixa frequência no webhook).
function resolverTenantPorUserId(tenantManager, userId) {
  const uid = String(userId);
  for (const t of tenantManager.listAll()) {
    try {
      const tdb = tenantManager.getDb(t.slug);
      if (tdb.prepare("SELECT 1 FROM marketplaces_integracoes WHERE canal='mercado-livre' AND mlUserId=? AND ativo=1").get(uid)) {
        return { slug: t.slug, db: tdb };
      }
    } catch {}
  }
  return null;
}

// Importa um pedido do ML: GET /orders/{id}, grava em marketplaces_pedidos e cria o pedido
// local COM itens (casando seller_sku → produtos.sku). Idempotente (UNIQUE canal+idExterno).
/**
 * Casa o item do anúncio com o produto do cadastro.
 *
 * Antes só tentava seller_sku exato: qualquer divergência de caixa,
 * espaço ou uso do GTIN deixava produtoId nulo — e item sem produto não
 * reserva nem baixa estoque, então a venda passava invisível pelo estoque.
 */
function casarProduto(db, it) {
  const cands = [it.seller_sku, it.seller_custom_field].filter(Boolean).map(String);
  for (const c of cands) {
    const exato = db.prepare('SELECT id FROM produtos WHERE sku = ? AND ativo = 1').get(c);
    if (exato) return { id: exato.id, via: 'sku' };
  }
  for (const c of cands) {
    const norm = c.trim().toUpperCase();
    const frouxo = db.prepare(
      "SELECT id FROM produtos WHERE UPPER(TRIM(sku)) = ? AND ativo = 1").get(norm);
    if (frouxo) return { id: frouxo.id, via: 'sku-normalizado' };
  }
  // GTIN/EAN vem nos atributos do anúncio.
  const gtin = (it.attributes || []).find(a => ['GTIN', 'EAN'].includes(String(a.id || '').toUpperCase()));
  const cod = gtin && String(gtin.value_name || '').replace(/\D/g, '');
  if (cod && cod.length >= 8) {
    const porEan = db.prepare(
      "SELECT id FROM produtos WHERE REPLACE(REPLACE(codigoBarras,'.',''),'-','') = ? AND ativo = 1").get(cod);
    if (porEan) return { id: porEan.id, via: 'gtin' };
  }
  return { id: null, via: null };
}

// Status do ML em que a mercadoria já é do comprador — dá baixa.
const ML_STATUS_BAIXA = new Set(['paid', 'shipped', 'delivered']);
const ML_STATUS_CANCELADO = new Set(['cancelled', 'invalid']);

async function importarPedido(db, orderId, log = () => {}) {
  const token = await getAccessTokenValido(db, log);
  if (!token) return { erro: 'sem token válido' };
  const r = await mlGet(token, `/orders/${orderId}`);
  if (!r.ok || !r.json) {
    db.prepare("INSERT INTO marketplaces_logs (canal, tipo, mensagem, sucesso) VALUES ('mercado-livre','pedido-fetch',?,0)").run(`GET /orders/${orderId} → ${r.status}`);
    return { erro: `fetch ${r.status}` };
  }
  const o = r.json;
  const b = o.buyer || {};
  const nome = [b.first_name, b.last_name].filter(Boolean).join(' ') || b.nickname || null;
  const formaPag = (o.payments && o.payments[0] && o.payments[0].payment_type) || null;
  const dataPed = String(o.date_created || '').slice(0, 10);

  db.prepare(`INSERT INTO marketplaces_pedidos
      (canal, idExterno, numeroExterno, compradorNome, compradorEmail, dataPedido, valorTotal, valorFrete, status, formaPagamento, dadosBrutos)
      VALUES ('mercado-livre', ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
      ON CONFLICT(canal, idExterno) DO UPDATE SET status=excluded.status, valorTotal=excluded.valorTotal, dadosBrutos=excluded.dadosBrutos`)
    .run(String(o.id), String(o.id), nome, b.email || null, dataPed, Number(o.total_amount) || 0,
      o.status || 'novo', formaPag, JSON.stringify(o).slice(0, 100000));

  const mp = db.prepare("SELECT id, pedidoIdLocal FROM marketplaces_pedidos WHERE canal='mercado-livre' AND idExterno=?").get(String(o.id));
  if (mp.pedidoIdLocal) {
    // Já importado: o webhook do ML dispara de novo a cada mudança de
    // status, e é aqui que pago/cancelado vira baixa/estorno.
    const sync = sincronizarStatusML(db, mp.pedidoIdLocal, o, log);
    return { ok: true, jaImportado: true, pedidoLocalId: mp.pedidoIdLocal, ...sync };
  }

  const semVinculo = [];
  let reserva = null;
  const pedidoLocalId = db.transaction(() => {
    const ult = db.prepare('SELECT numero FROM pedidos ORDER BY id DESC LIMIT 1').get();
    let n = 1; if (ult) { const m = String(ult.numero).match(/(\d+)/); if (m) n = parseInt(m[1], 10) + 1; }
    const pr = db.prepare(`INSERT INTO pedidos (numero, tipo, status, dataPedido, valorTotal, observacao)
        VALUES (?, 'marketplace', 'confirmado', ?, ?, ?)`)
      .run('ML-' + String(n).padStart(6, '0'), dataPed, Number(o.total_amount) || 0, `Mercado Livre #${o.id} (${nome || 'sem nome'})`);
    const pid = pr.lastInsertRowid;
    const stmt = db.prepare('INSERT INTO pedido_itens (pedidoId, produtoId, descricao, quantidade, precoUnitario, valorTotal) VALUES (?,?,?,?,?,?)');
    for (const oi of (o.order_items || [])) {
      const it = oi.item || {};
      const sku = it.seller_sku || it.seller_custom_field || null;
      const prod = casarProduto(db, it);
      const qtd = Number(oi.quantity) || 0, unit = Number(oi.unit_price) || 0;
      stmt.run(pid, prod.id, it.title || sku || 'Item ML', qtd, unit, Number((qtd * unit).toFixed(2)));
      if (!prod.id) semVinculo.push(sku || it.title || '?');
    }
    db.prepare("UPDATE marketplaces_pedidos SET pedidoIdLocal=?, status='vinculado' WHERE id=?").run(pid, mp.id);
    // O pedido nascia 'confirmado' direto no banco, sem passar pelos
    // endpoints que criam reserva — venda de marketplace não tocava o
    // estoque. Agora reserva na importação, como qualquer confirmação.
    reserva = criarReservasPedido(db, pid);
    return pid;
  })();

  // Pago/enviado/entregue = mercadoria já é do comprador: dá baixa.
  const baixa = ML_STATUS_BAIXA.has(String(o.status || '').toLowerCase())
    ? sincronizarStatusML(db, pedidoLocalId, o, log) : null;

  const partes = [`Pedido ML ${o.id} → local #${pedidoLocalId}`];
  if (semVinculo.length) partes.push(`${semVinculo.length} item(ns) SEM PRODUTO (não reservam nem baixam estoque)`);
  if (reserva) partes.push(`${reserva.reservasCriadas.length} reserva(s)`);
  if (reserva && reserva.insuficiencias.length) partes.push(`${reserva.insuficiencias.length} item(ns) sem saldo`);
  if (baixa && baixa.baixado) partes.push('estoque baixado');
  const msg = partes.join(' · ');
  db.prepare("INSERT INTO marketplaces_logs (canal, tipo, mensagem, sucesso) VALUES ('mercado-livre','pedido-import',?,?)")
    .run(msg, semVinculo.length ? 0 : 1);
  log(`[ML] ${msg}`);
  return { ok: true, pedidoLocalId, itensSemVinculo: semVinculo,
           reservas: reserva ? reserva.reservasCriadas.length : 0,
           insuficiencias: reserva ? reserva.insuficiencias : [],
           baixado: !!(baixa && baixa.baixado) };
}

/**
 * Reflete o status do ML no pedido local: pago/enviado dá baixa de
 * estoque, cancelado devolve a reserva. Sem isto o pedido de marketplace
 * ficava eternamente 'confirmado' e a mercadoria nunca saía do saldo.
 */
function sincronizarStatusML(db, pedidoLocalId, o, log = () => {}) {
  const ped = db.prepare('SELECT * FROM pedidos WHERE id = ?').get(pedidoLocalId);
  if (!ped) return { baixado: false };
  const st = String(o.status || '').toLowerCase();
  const hoje = new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);

  if (ML_STATUS_CANCELADO.has(st)) {
    if (ped.status === 'cancelado') return { baixado: false };
    db.transaction(() => {
      cancelarReservasPedido(db, pedidoLocalId, `Cancelado no Mercado Livre (${st})`);
      db.prepare("UPDATE pedidos SET status='cancelado', dataAtualizacao=CURRENT_TIMESTAMP WHERE id=?").run(pedidoLocalId);
      db.prepare(`INSERT INTO pedido_historico (pedidoId, statusAnterior, statusNovo, acao, motivo, usuario)
        VALUES (?, ?, 'cancelado', 'cancelar', ?, 'mercado-livre')`)
        .run(pedidoLocalId, ped.status, `Pedido cancelado no Mercado Livre (${st})`);
    })();
    log(`[ML] pedido local #${pedidoLocalId} cancelado (ML ${st})`);
    return { baixado: false, cancelado: true };
  }

  if (!ML_STATUS_BAIXA.has(st) || ped.status === 'entregue' || ped.status === 'faturado') {
    return { baixado: false };
  }

  db.transaction(() => {
    consumirReservasPedido(db, pedidoLocalId, hoje);
    db.prepare(`UPDATE pedidos SET status='entregue', dataEntregaReal=?, dataAtualizacao=CURRENT_TIMESTAMP WHERE id=?`)
      .run(hoje, pedidoLocalId);
    db.prepare(`INSERT INTO pedido_historico (pedidoId, statusAnterior, statusNovo, acao, motivo, usuario)
      VALUES (?, ?, 'entregue', 'entregar', ?, 'mercado-livre')`)
      .run(pedidoLocalId, ped.status, `Baixa automática — status ${st} no Mercado Livre`);
  })();
  log(`[ML] pedido local #${pedidoLocalId} baixado (ML ${st})`);
  return { baixado: true };
}

// Processa uma notificação do webhook (só orders_v2 por ora).
async function processarNotificacao(notif, tenantManager, log = () => {}) {
  if (!notif || notif.topic !== 'orders_v2') return;
  const m = String(notif.resource || '').match(/\/orders\/(\w+)/);
  if (!m) return;
  const alvo = resolverTenantPorUserId(tenantManager, notif.user_id);
  if (!alvo) { log(`[ML] webhook user_id ${notif.user_id} sem tenant conectado`); return; }
  await importarPedido(alvo.db, m[1], log);
}

// ─── Fase 2: estoque (mapeamento + push gated) ───────────────────────────────
async function mlPut(accessToken, apiPath, body) {
  const r = await fetch(`${API_BASE}${apiPath}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { ok: r.ok, status: r.status, body: r.ok ? await r.json().catch(() => null) : await r.text().catch(() => null) };
}
// seller_sku pode vir como seller_sku, seller_custom_field ou no atributo SELLER_SKU.
function skuDoItem(it) {
  if (it.seller_sku) return String(it.seller_sku);
  if (it.seller_custom_field) return String(it.seller_custom_field);
  const at = (it.attributes || []).find(a => a.id === 'SELLER_SKU');
  return at?.value_name ? String(at.value_name) : null;
}

// Puxa os anúncios do vendedor e casa seller_sku → produtos.sku. READ-ONLY (não altera o ML).
async function sincronizarItensML(db, log = () => {}) {
  const token = await getAccessTokenValido(db, log);
  if (!token) return { erro: 'sem token' };
  const integ = db.prepare("SELECT mlUserId FROM marketplaces_integracoes WHERE canal='mercado-livre'").get();
  const uid = integ && integ.mlUserId;
  if (!uid) return { erro: 'sem mlUserId' };

  const ids = [];
  let offset = 0;
  for (let p = 0; p < 40; p++) { // até ~2000 anúncios
    const s = await mlGet(token, `/users/${uid}/items/search?limit=50&offset=${offset}`);
    if (!s.ok || !s.json) break;
    const res = s.json.results || [];
    ids.push(...res);
    offset += 50;
    if (!res.length || ids.length >= (s.json.paging?.total || 0)) break;
  }

  let mapeados = 0, semMatch = 0;
  const upsert = db.prepare(`INSERT INTO ml_item_map (mlItemId, produtoId, sku, titulo, qtdML, atualizadoEm)
    VALUES (?,?,?,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(mlItemId) DO UPDATE SET produtoId=excluded.produtoId, sku=excluded.sku, titulo=excluded.titulo, qtdML=excluded.qtdML, atualizadoEm=CURRENT_TIMESTAMP`);
  for (let i = 0; i < ids.length; i += 20) {
    const batch = ids.slice(i, i + 20).join(',');
    const m = await mlGet(token, `/items?ids=${batch}&attributes=id,seller_sku,seller_custom_field,available_quantity,title,attributes`);
    if (!m.ok || !Array.isArray(m.json)) continue;
    for (const w of m.json) {
      const it = w.body || {};
      if (!it.id) continue;
      const sku = skuDoItem(it);
      const prod = sku ? db.prepare('SELECT id FROM produtos WHERE sku=?').get(sku) : null;
      upsert.run(it.id, prod ? prod.id : null, sku, it.title || null, Number(it.available_quantity) || 0);
      if (prod) mapeados++; else semMatch++;
    }
  }
  db.prepare("UPDATE marketplaces_integracoes SET ultimaSync=CURRENT_TIMESTAMP WHERE canal='mercado-livre'").run();
  log(`[ML] anúncios: ${ids.length} (mapeados ${mapeados}, sem produto ${semMatch})`);
  return { total: ids.length, mapeados, semMatch };
}

// Empurra o saldo local → available_quantity do ML. GATED: só roda com sincronizarEstoque=1
// (senão zeraria o estoque de anúncios cujo produto não é gerido no ERP). opts.dryRun não PUTa.
async function pushEstoqueML(db, log = () => {}, opts = {}) {
  const integ = db.prepare("SELECT sincronizarEstoque FROM marketplaces_integracoes WHERE canal='mercado-livre' AND ativo=1").get();
  if (!integ) return { skip: 'sem integração' };
  if (!opts.dryRun && Number(integ.sincronizarEstoque) !== 1) return { skip: 'sincronização de estoque desligada' };
  const token = await getAccessTokenValido(db, log);
  if (!token) return { erro: 'sem token' };
  const mapeados = db.prepare('SELECT mlItemId, produtoId, qtdML FROM ml_item_map WHERE produtoId IS NOT NULL').all();
  const mudancas = [];
  for (const m of mapeados) {
    const row = db.prepare(`SELECT COALESCE(SUM(CASE WHEN tipo='entrada' THEN quantidade WHEN tipo='saida' THEN -quantidade ELSE quantidade END),0) s
      FROM movimentacoes_estoque WHERE produtoId=?`).get(m.produtoId);
    const saldo = Math.max(0, Math.floor(Number(row.s) || 0));
    if (saldo === Number(m.qtdML)) continue;
    if (!opts.dryRun) {
      const r = await mlPut(token, `/items/${m.mlItemId}`, { available_quantity: saldo });
      if (!r.ok) { log(`[ML] push ${m.mlItemId} falhou ${r.status}`); continue; }
      db.prepare('UPDATE ml_item_map SET qtdML=?, ultimoPushEm=CURRENT_TIMESTAMP WHERE mlItemId=?').run(saldo, m.mlItemId);
    }
    mudancas.push({ mlItemId: m.mlItemId, de: Number(m.qtdML), para: saldo });
  }
  return { mudancas, aplicado: !opts.dryRun };
}

// ─── Fase 3: NF-e do pedido ML ───────────────────────────────────────────────
// Dados fiscais do comprador (CPF/CNPJ + nome + endereço) — vêm de billing_info, não do pedido.
async function buscarBillingInfo(token, orderId) {
  const r = await mlGet(token, `/orders/${orderId}/billing_info`);
  const bi = r.ok && r.json && r.json.billing_info;
  if (!bi) return null;
  const ai = {};
  for (const p of (bi.additional_info || [])) ai[p.type] = p.value;
  return {
    docType: ai.DOC_TYPE || null,
    docNumber: (ai.DOC_NUMBER || '').replace(/\D/g, '') || null,
    nome: [ai.FIRST_NAME, ai.LAST_NAME].filter(Boolean).join(' ') || ai.BUSINESS_NAME || null,
    ie: ai.STATE_REGISTRATION || null,
    endereco: ai.STREET_NAME || null, numero: ai.STREET_NUMBER || null,
    bairro: ai.NEIGHBORHOOD || null, cidade: ai.CITY_NAME || ai.CITY || null,
    uf: ai.STATE_NAME || ai.STATE || null, cep: (ai.ZIP_CODE || '').replace(/\D/g, '') || null,
  };
}

// Garante a pessoa (destinatário) do comprador ML por CPF/CNPJ.
function garantirPessoaComprador(db, bill) {
  const doc = (bill.docNumber || '').replace(/\D/g, '');
  if (!doc) throw new Error('Comprador sem CPF/CNPJ (billing_info)');
  const ex = db.prepare("SELECT id FROM pessoas WHERE REPLACE(REPLACE(REPLACE(cpfCnpj,'.',''),'/',''),'-','') = ?").get(doc);
  if (ex) return ex.id;
  const r = db.prepare(`INSERT INTO pessoas (cpfCnpj, tipo, razaoSocial, endereco, numero, bairro, cidade, uf, cep, inscricaoEstadual)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    doc, doc.length === 14 ? 'PJ' : 'PF', bill.nome || 'CLIENTE MERCADO LIVRE',
    bill.endereco, bill.numero, bill.bairro, bill.cidade, bill.uf, bill.cep, bill.ie);
  return r.lastInsertRowid;
}

// Sobe o XML da NF-e autorizada pro ML (multipart) — ML gera o DANFE. Não vale p/ Full.
async function enviarNfeAoML(token, packId, xmlAssinado) {
  const fd = new FormData();
  fd.append('fiscal_document', new Blob([xmlAssinado], { type: 'application/xml' }), 'nfe.xml');
  const r = await fetch(`${API_BASE}/packs/${packId}/fiscal_documents`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd,
  });
  return { ok: r.ok, status: r.status, body: r.ok ? await r.json().catch(() => null) : await r.text().catch(() => null) };
}

// Emite a NF-e de um pedido ML: billing_info → pessoa, cria fatura de venda a partir do
// pedido local (itens precisam de produto vinculado) e emite via emitirNFe; no sucesso,
// sobe o XML pro ML. Pagamento já feito no ML → sem cobrança nova (tPag 99 outros).
async function emitirNfeDoPedidoML(db, mpId, log = () => {}) {
  const mp = db.prepare("SELECT * FROM marketplaces_pedidos WHERE id=? AND canal='mercado-livre'").get(mpId);
  if (!mp) return { erro: 'pedido ML não encontrado' };
  if (!mp.pedidoIdLocal) return { erro: 'pedido sem vínculo local' };
  const jaFat = db.prepare("SELECT id, statusSefaz, chaveAcesso FROM faturas WHERE pedidoId=? AND IFNULL(excluida,0)=0 ORDER BY id DESC LIMIT 1").get(mp.pedidoIdLocal);
  if (jaFat && jaFat.statusSefaz === 'autorizada') return { erro: 'NF-e já autorizada', chaveAcesso: jaFat.chaveAcesso, faturaId: jaFat.id };

  const token = await getAccessTokenValido(db, log);
  if (!token) return { erro: 'sem token' };
  const bill = await buscarBillingInfo(token, mp.idExterno);
  if (!bill || !bill.docNumber) return { erro: 'sem CPF/CNPJ do comprador (billing_info)' };
  const clienteId = garantirPessoaComprador(db, bill);

  const itens = db.prepare('SELECT produtoId, descricao, quantidade, precoUnitario, valorTotal FROM pedido_itens WHERE pedidoId=?').all(mp.pedidoIdLocal);
  const semProd = itens.filter(i => !i.produtoId);
  if (semProd.length) return { erro: `${semProd.length} item(ns) sem produto vinculado — vincule ao catálogo antes de emitir`, itensSemVinculo: semProd.map(i => i.descricao) };

  const hoje = new Date().toISOString().slice(0, 10);
  const total = itens.reduce((s, i) => s + Number(i.valorTotal || 0), 0);
  const faturaId = db.transaction(() => {
    const ult = db.prepare('SELECT numero FROM faturas ORDER BY id DESC LIMIT 1').get();
    let n = 1; if (ult) { const m = String(ult.numero).match(/(\d+)/); if (m) n = parseInt(m[1], 10) + 1; }
    const fr = db.prepare(`INSERT INTO faturas (numero, pedidoId, clienteId, dataEmissao, dataVencimento,
        valorBruto, valorTotal, status, meioPagamento, observacao)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'emitida', '99', ?)`)
      .run('FT-ML-' + String(n).padStart(6, '0'), mp.pedidoIdLocal, clienteId, hoje, hoje, total, total,
        `Venda Mercado Livre #${mp.idExterno}`);
    const fid = fr.lastInsertRowid;
    const st = db.prepare(`INSERT INTO fatura_itens (faturaId, produtoId, sku, descricao, unidade, quantidade, precoUnitario, valorTotal, ncm, cfop, origem)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const it of itens) {
      const p = db.prepare('SELECT sku, ncm, cfopPadrao, origem, unidade FROM produtos WHERE id=?').get(it.produtoId) || {};
      st.run(fid, it.produtoId, p.sku || '', (it.descricao || '').substring(0, 120), p.unidade || 'UN',
        it.quantidade, it.precoUnitario, it.valorTotal, p.ncm || '00000000', p.cfopPadrao || '5102', p.origem || '0');
    }
    return fid;
  })();

  const { emitirNFe } = require('./nfe-emit-routes');
  let emissao;
  try { emissao = await emitirNFe(db, faturaId); }
  catch (e) { return { erro: 'Falha na emissão: ' + e.message, faturaId }; }
  const fat = db.prepare('SELECT statusSefaz, chaveAcesso, xmlAssinado, rejeicaoMotivo FROM faturas WHERE id=?').get(faturaId);
  if (fat.statusSefaz !== 'autorizada') return { erro: 'NF-e não autorizada: ' + (fat.rejeicaoMotivo || emissao?.xMotivo), faturaId, statusSefaz: fat.statusSefaz };

  // Sobe pro ML (best-effort — a NF-e já está autorizada).
  let envioML = null;
  if (mp.dadosBrutos) {
    try {
      const packId = JSON.parse(mp.dadosBrutos).pack_id || mp.idExterno;
      const r = await enviarNfeAoML(token, packId, fat.xmlAssinado);
      envioML = { ok: r.ok, status: r.status };
      db.prepare("INSERT INTO marketplaces_logs (canal, tipo, mensagem, sucesso) VALUES ('mercado-livre','nfe-ml',?,?)")
        .run(`NF-e ${fat.chaveAcesso} → pack ${packId}: ${r.status}`, r.ok ? 1 : 0);
    } catch (e) { envioML = { ok: false, erro: e.message }; }
  }
  log(`[ML] NF-e do pedido ${mp.idExterno} autorizada (${fat.chaveAcesso})`);
  return { ok: true, faturaId, chaveAcesso: fat.chaveAcesso, envioML };
}

// ─── Rotas ───────────────────────────────────────────────────────────────────
// Per-tenant (autenticada): inicia o OAuth. Registrada no route-registry.
function registrarRotasTenant(app, db) {
  const anuncios = require('./marketplaces-ml-anuncios');
  anuncios.migrarAnunciosDB(db);
  registrarRotasAnuncios(app, db, anuncios);

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

  // Import manual de um pedido (teste): POST { orderId }. Útil pra validar sem esperar
  // a notificação real (o ID de um pedido vem do painel de vendas do ML).
  app.post('/api/marketplaces/ml/importar', async (req, res) => {
    try {
      const orderId = String((req.body && req.body.orderId) || '').trim();
      if (!orderId) return res.status(400).json({ success: false, error: 'orderId obrigatório' });
      const r = await importarPedido(req.tenantDb || db, orderId, (m) => console.log(m));
      res.json({ success: !r.erro, ...r });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  // Fase 2 — sincroniza o mapa de anúncios ↔ produtos (READ-ONLY, não altera o ML).
  app.post('/api/marketplaces/ml/sync-itens', async (req, res) => {
    try { const r = await sincronizarItensML(req.tenantDb || db, (m) => console.log(m)); res.json({ success: !r.erro, ...r }); }
    catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });
  // Fase 2 — push de estoque ERP→ML. { dryRun:true } só mostra o que mudaria (não altera o ML).
  app.post('/api/marketplaces/ml/sync-estoque', async (req, res) => {
    try { const r = await pushEstoqueML(req.tenantDb || db, (m) => console.log(m), { dryRun: !!(req.body && req.body.dryRun) }); res.json({ success: !r.erro, ...r }); }
    catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });
  // Fase 2 — liga/desliga a sincronização de estoque (default OFF; ligar = ERP vira fonte da verdade).
  app.post('/api/marketplaces/ml/config', (req, res) => {
    try {
      const on = (req.body && req.body.sincronizarEstoque) ? 1 : 0;
      (req.tenantDb || db).prepare("UPDATE marketplaces_integracoes SET sincronizarEstoque=? WHERE canal='mercado-livre'").run(on);
      res.json({ success: true, sincronizarEstoque: on });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });
  // Fase 3 — emite a NF-e de um pedido ML (billing_info → destinatário; reusa emitirNFe; sobe ao ML).
  app.post('/api/marketplaces/ml/emitir-nfe', async (req, res) => {
    try {
      const mpId = Number((req.body && req.body.marketplacePedidoId) || 0);
      if (!mpId) return res.status(400).json({ success: false, error: 'marketplacePedidoId obrigatório' });
      const r = await emitirNfeDoPedidoML(req.tenantDb || db, mpId, (m) => console.log(m));
      res.json({ success: !r.erro, ...r });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });
}

// Global (apex, pública): recebe o callback do ML. Registrada no server.js com tenantManager.
/**
 * Rotas de criação de anúncio. Gerar rascunho é livre; publicar é ato
 * explícito, um a um ou em lote, e sempre depois de validar.
 */
function registrarRotasAnuncios(app, db, anuncios) {
  const imgs = require('./produto-imagens');
  imgs.migrarImagensDB(db);
  const RAIZ_PUBLICA = require('path').join(__dirname, 'public');

  // Imagem por URL de origem. É o caminho do "usar a foto oficial do
  // fabricante": você aponta a fonte de onde tem direito de uso, o sistema
  // baixa, hospeda e registra a origem — em vez de raspar a web às cegas.
  app.post('/api/marketplaces/ml/produtos/:id/imagens', async (req, res) => {
    try {
      const r = await imgs.adicionarImagem(db, Number(req.params.id), {
        url: req.body?.url, origem: req.body?.origem || 'outra',
        usuario: req.session?.username || null, raizPublica: RAIZ_PUBLICA,
      });
      res.json({ success: true, imagem: r });
    } catch (e) { res.status(400).json({ success: false, error: e.message }); }
  });

  app.get('/api/marketplaces/ml/produtos/:id/imagens', (req, res) => {
    try { res.json({ success: true, imagens: imgs.listarImagens(db, Number(req.params.id)) }); }
    catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  app.delete('/api/marketplaces/ml/produtos/:id/imagens/:imgId', (req, res) => {
    try {
      const r = imgs.removerImagem(db, Number(req.params.id), Number(req.params.imgId),
        { raizPublica: RAIZ_PUBLICA });
      res.json({ success: true, ...r });
    } catch (e) { res.status(400).json({ success: false, error: e.message }); }
  });

  // Lote: uma URL por produto. Cada item é independente — uma origem fora do
  // ar não pode derrubar as outras.
  // Foto nova no produto tem que chegar ao rascunho que já existe. A lista de
  // fotos é gravada na geração; sem isto, quem baixa a imagem continua vendo
  // "produto sem imagem" no rascunho e não tem como adivinhar que falta regerar.
  const sincronizarFotosDoRascunho = (produtoId, req) => {
    try {
      const a = db.prepare(`SELECT id FROM ml_anuncios
        WHERE produtoId = ? AND status <> 'publicado'`).get(produtoId);
      if (!a) return null;
      const produto = db.prepare('SELECT * FROM produtos WHERE id = ?').get(produtoId);
      const fotos = anuncios.fotosDe(produto, baseUrlDe(req), db);
      db.prepare(`UPDATE ml_anuncios SET fotos = ?, dataAtualizacao = CURRENT_TIMESTAMP
        WHERE id = ?`).run(JSON.stringify(fotos), a.id);
      return fotos.length;
    } catch { return null; }  // sincronizar é bônus: não pode derrubar o download
  };

  app.post('/api/marketplaces/ml/produtos/imagens-lote', async (req, res) => {
    try {
      const itens = Array.isArray(req.body?.itens) ? req.body.itens : [];
      if (!itens.length) return res.status(400).json({ success: false, error: 'Informe itens [{produtoId, url}]' });
      if (itens.length > 50) return res.status(400).json({ success: false, error: 'No máximo 50 por vez' });
      const origem = req.body?.origem || 'outra';
      const ok = [], falhas = [];
      for (const it of itens) {
        try {
          const r = await imgs.adicionarImagem(db, Number(it.produtoId), {
            url: it.url, origem, usuario: req.session?.username || null, raizPublica: RAIZ_PUBLICA });
          ok.push({ produtoId: it.produtoId, caminho: r.caminho });
        } catch (e) { falhas.push({ produtoId: it.produtoId, url: it.url, erro: e.message }); }
      }
      const rascunhos = [...new Set(ok.map(x => Number(x.produtoId)))]
        .map(pid => sincronizarFotosDoRascunho(pid, req)).filter(n => n != null).length;
      res.json({ success: true, baixadas: ok.length, ok, falhas, rascunhosAtualizados: rascunhos });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  // Fotos oficiais do catálogo do ML. Por GTIN o casamento é exato; com
  // catalogProductId no corpo, quem casou foi o usuário olhando a foto.
  app.post('/api/marketplaces/ml/produtos/:id/imagens-do-catalogo', async (req, res) => {
    try {
      const id = Number(req.params.id);
      const p = db.prepare('SELECT codigoBarras FROM produtos WHERE id = ?').get(id);
      if (!p) return res.status(404).json({ success: false, error: 'Produto não encontrado' });
      let token = null;
      try { token = await getAccessTokenValido(db, console.log); } catch { }

      const escolhido = String(req.body?.catalogProductId || '').trim();
      let cat;
      if (escolhido) {
        cat = (await anuncios.fotosDeCatalogos([{ id: escolhido, nome: '' }], { token }))[0];
        if (!cat) return res.status(400).json({ success: false,
          error: 'Esse produto do catálogo não tem foto disponível' });
      } else {
        cat = await anuncios.buscarNoCatalogoML(p.codigoBarras, { token });
        if (!cat?.fotos?.length) {
          return res.status(400).json({ success: false,
            error: 'Este código de barras não casou com nenhum produto do catálogo do Mercado Livre' });
        }
      }
      const ok = [], falhas = [];
      for (const url of cat.fotos.slice(0, 8)) {
        try {
          ok.push(await imgs.adicionarImagem(db, id, { url, origem: 'catalogo-ml',
            usuario: req.session?.username || null, raizPublica: RAIZ_PUBLICA }));
        } catch (e) { falhas.push({ url, erro: e.message }); }
      }
      const noRascunho = ok.length ? sincronizarFotosDoRascunho(id, req) : null;
      res.json({ success: true, catalogo: cat.id, baixadas: ok.length, falhas, noRascunho });
    } catch (e) { res.status(400).json({ success: false, error: e.message }); }
  });

  // Produtos de catálogo parecidos com o cadastro. Servem para duas coisas:
  // pegar as fotos oficiais e vincular o anúncio à página do produto no ML.
  app.post('/api/marketplaces/ml/produtos/:id/catalogo-candidatos', async (req, res) => {
    try {
      const id = Number(req.params.id);
      const p = db.prepare('SELECT sku, descricao, marca, modelo FROM produtos WHERE id = ?').get(id);
      if (!p) return res.status(404).json({ success: false, error: 'Produto não encontrado' });
      let token = null;
      try { token = await getAccessTokenValido(db, console.log); } catch { }
      const termo = String(req.body?.termo || '').trim()
        || [p.descricao, p.marca, p.modelo].filter(Boolean).join(' ');
      const catalogos = await anuncios.catalogosParecidos(termo, { token, limite: 8 });
      const candidatos = await anuncios.fotosDeCatalogos(catalogos, { token });
      res.json({ success: true, termo, candidatos });
    } catch (e) { res.status(400).json({ success: false, error: e.message }); }
  });

  const chavesIA = () => {
    const pega = (k) => {
      try { return db.prepare('SELECT valor FROM config WHERE chave = ?').get(k)?.valor || null; }
      catch { return null; }
    };
    return {
      cerebras: pega('cerebras_api_key'), gemini: pega('gemini_api_key'),
      deepseek: pega('deepseek_api_key'), groq: pega('groq_api_key'),
      anthropic: pega('anthropic_api_key'),
    };
  };
  // O ML baixa a foto da URL que mandamos, então precisa ser endereço público.
  const baseUrlDe = (req) => {
    const host = req.get?.('host') || req.headers?.host;
    return host ? `${req.protocol || 'https'}://${host}` : null;
  };

  app.get('/api/marketplaces/ml/anuncios/candidatos', (req, res) => {
    try {
      const lista = anuncios.candidatos(db, { limit: Number(req.query.limit) || 200 });
      res.json({ success: true, produtos: lista,
        resumo: {
          total: lista.length,
          prontos: lista.filter(p => p.pronto && !p.anuncioId).length,
          comRascunho: lista.filter(p => p.anuncioStatus === 'rascunho').length,
          publicados: lista.filter(p => p.anuncioStatus === 'publicado').length,
          semImagem: lista.filter(p => p.pendencias.includes('sem imagem')).length,
        } });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  app.get('/api/marketplaces/ml/anuncios', (req, res) => {
    try {
      const linhas = db.prepare(`SELECT a.*, p.sku, p.descricao AS produtoDescricao
        FROM ml_anuncios a JOIN produtos p ON p.id = a.produtoId
        ${req.query.status ? 'WHERE a.status = ?' : ''}
        ORDER BY a.dataAtualizacao DESC`).all(...(req.query.status ? [req.query.status] : []));
      res.json({ success: true, anuncios: linhas });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  // Um rascunho inteiro, com as pendências recalculadas agora. Os atributos
  // obrigatórios não são persistidos na geração, então vêm do ML na hora —
  // sem isso a tela não teria como dizer qual atributo falta.
  app.get('/api/marketplaces/ml/anuncios/:id', async (req, res) => {
    try {
      const a = db.prepare(`SELECT a.*, p.sku, p.descricao AS produtoDescricao,
             p.precoVenda AS produtoPreco, p.imagemPath, p.codigoBarras, p.marca AS produtoMarca
        FROM ml_anuncios a JOIN produtos p ON p.id = a.produtoId WHERE a.id = ?`).get(req.params.id);
      if (!a) return res.status(404).json({ success: false, error: 'Rascunho não encontrado' });
      let obrigatorios = [];
      if (a.categoriaId) {
        try { obrigatorios = (await anuncios.atributosCategoria(a.categoriaId)).obrigatorios; }
        catch { /* ML fora do ar: a tela ainda mostra o resto do rascunho */ }
      }
      const produto = db.prepare('SELECT * FROM produtos WHERE id = ?').get(a.produtoId);
      const bloqueios = anuncios.validarRascunho(
        { ...a, atributosObrigatorios: JSON.stringify(obrigatorios) }, produto, a.quantidade);
      res.json({ success: true, anuncio: a, obrigatorios, bloqueios });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  // Vincula (ou desvincula) o rascunho a um produto do catálogo do ML. É a
  // saída para categoria que exige GTIN: no anúncio de catálogo, a identidade
  // do produto é a do ML — o código de barras deixa de ser exigido de você.
  app.put('/api/marketplaces/ml/anuncios/:id/catalogo', async (req, res) => {
    try {
      const a = db.prepare('SELECT * FROM ml_anuncios WHERE id = ?').get(req.params.id);
      if (!a) return res.status(404).json({ success: false, error: 'Rascunho não encontrado' });
      if (a.status === 'publicado') {
        return res.status(400).json({ success: false, error: 'Anúncio já publicado — altere pelo Mercado Livre' });
      }
      const alvo = String(req.body?.catalogProductId || '').trim() || null;
      if (alvo) {
        // Se o produto de catálogo declarar categoria, ela manda; nem todo
        // produto traz esse campo, e aí fica a que o preditor já escolheu.
        let token = null;
        try { token = await getAccessTokenValido(db, console.log); } catch { }
        const h = token ? { headers: { Authorization: `Bearer ${token}` } } : {};
        const r = await fetch(`https://api.mercadolibre.com/products/${encodeURIComponent(alvo)}`, h);
        const p = r.ok ? await r.json().catch(() => null) : null;
        if (!p?.id) return res.status(400).json({ success: false, error: 'Produto de catálogo não encontrado no Mercado Livre' });
        db.prepare(`UPDATE ml_anuncios SET catalogProductId = ?, categoriaId = COALESCE(?, categoriaId),
            status = 'rascunho', erro = NULL, dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?`)
          .run(alvo, p.category_id || null, a.id);
        return res.json({ success: true, catalogProductId: alvo, nome: p.name || null,
                          categoriaId: p.category_id || a.categoriaId });
      }
      db.prepare(`UPDATE ml_anuncios SET catalogProductId = NULL, status='rascunho', erro = NULL,
          dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?`).run(a.id);
      res.json({ success: true, catalogProductId: null });
    } catch (e) { res.status(400).json({ success: false, error: e.message }); }
  });

  // Situação real do anúncio já publicado. O `status` do nosso banco diz que
  // foi criado; quem sabe se ele está no ar é o ML — um item nasce pausado
  // quando o ML não consegue baixar a foto, por exemplo.
  const MOTIVO_SUB_STATUS = {
    picture_download_pending: 'o Mercado Livre ainda não conseguiu baixar a foto do seu servidor',
    out_of_stock: 'sem estoque disponível no anúncio',
    waiting_for_patch: 'o anúncio precisa de correção de dados',
    suspended: 'anúncio suspenso pelo Mercado Livre',
    deleted: 'anúncio excluído',
    freezed: 'anúncio congelado por moderação',
  };
  app.get('/api/marketplaces/ml/anuncios/:id/situacao', async (req, res) => {
    try {
      const a = db.prepare('SELECT * FROM ml_anuncios WHERE id = ?').get(req.params.id);
      if (!a?.mlItemId) return res.status(400).json({ success: false, error: 'Este anúncio ainda não foi publicado' });
      const token = await getAccessTokenValido(db, console.log);
      const r = await mlGet(token, `/items/${a.mlItemId}`);
      if (!r.ok || !r.json) return res.status(400).json({ success: false, error: `Mercado Livre respondeu HTTP ${r.status}` });
      const sub = Array.isArray(r.json.sub_status) ? r.json.sub_status : [];
      res.json({ success: true, mlItemId: a.mlItemId, status: r.json.status, subStatus: sub,
        motivos: sub.map(s => MOTIVO_SUB_STATUS[s] || s),
        podeReenviarFoto: sub.includes('picture_download_pending'),
        permalink: r.json.permalink || a.permalink,
        quantidade: r.json.available_quantity, preco: r.json.price, fotos: (r.json.pictures || []).length });
    } catch (e) { res.status(400).json({ success: false, error: e.message }); }
  });

  // Reenvia as fotos e tira o anúncio da pausa. Serve para o caso em que a
  // imagem não estava acessível na hora da publicação e passou a estar.
  app.post('/api/marketplaces/ml/anuncios/:id/reenviar-fotos', async (req, res) => {
    try {
      const a = db.prepare('SELECT * FROM ml_anuncios WHERE id = ?').get(req.params.id);
      if (!a?.mlItemId) return res.status(400).json({ success: false, error: 'Este anúncio ainda não foi publicado' });
      const token = await getAccessTokenValido(db, console.log);
      const produto = db.prepare('SELECT * FROM produtos WHERE id = ?').get(a.produtoId);
      const fotos = anuncios.fotosDe(produto, baseUrlDe(req), db);
      if (!fotos.length) return res.status(400).json({ success: false, error: 'O produto não tem foto para reenviar' });

      // Sobe o arquivo em vez de passar a URL: quando o ML tem que baixar do
      // nosso servidor, uma falha silenciosa dele deixa o anúncio pausado em
      // picture_download_pending sem erro nenhum na resposta.
      const { pictures, falhas } = await anuncios.subirFotos(fotos,
        { token, raizPublica: RAIZ_PUBLICA, log: console.log });
      if (!pictures.some(p => p.id)) {
        return res.status(400).json({ success: false,
          error: 'Nenhuma foto pôde ser enviada ao Mercado Livre'
            + (falhas.length ? `: ${falhas.map(f => f.erro).join('; ')}` : '') });
      }

      const put = await fetch(`https://api.mercadolibre.com/items/${a.mlItemId}`, {
        method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ pictures }),
      });
      const jp = await put.json().catch(() => null);
      if (!put.ok) {
        return res.status(400).json({ success: false, error: anuncios.descreverCausas(jp) || `HTTP ${put.status}` });
      }
      // Com a foto no lugar, reativar. Se o ML ainda estiver baixando, ele
      // mesmo recusa e o motivo volta na resposta.
      const act = await fetch(`https://api.mercadolibre.com/items/${a.mlItemId}`, {
        method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'active' }),
      });
      const ja = await act.json().catch(() => null);
      res.json({ success: true, fotosEnviadas: fotos.length,
        status: ja?.status || jp?.status || null,
        subStatus: Array.isArray(ja?.sub_status) ? ja.sub_status : [],
        aviso: act.ok ? null : (anuncios.descreverCausas(ja) || `não foi possível reativar (HTTP ${act.status})`) });
    } catch (e) { res.status(400).json({ success: false, error: e.message }); }
  });

  // Pausar, reativar ou encerrar o anúncio no ML. Encerrar é definitivo lá:
  // um item `closed` não volta a ficar ativo, tem que ser publicado de novo.
  app.post('/api/marketplaces/ml/anuncios/:id/status', async (req, res) => {
    try {
      const novo = String(req.body?.status || '').trim();
      if (!['active', 'paused', 'closed'].includes(novo)) {
        return res.status(400).json({ success: false, error: 'Status deve ser active, paused ou closed' });
      }
      const a = db.prepare('SELECT * FROM ml_anuncios WHERE id = ?').get(req.params.id);
      if (!a?.mlItemId) return res.status(400).json({ success: false, error: 'Este anúncio ainda não foi publicado' });
      const token = await getAccessTokenValido(db, console.log);
      const r = await fetch(`https://api.mercadolibre.com/items/${a.mlItemId}`, {
        method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: novo }),
      });
      const j = await r.json().catch(() => null);
      if (!r.ok) return res.status(400).json({ success: false, error: anuncios.descreverCausas(j) || `HTTP ${r.status}` });
      // Encerrado no ML deixa de ser "publicado" aqui — é o que libera
      // regerar o rascunho e apagar o registro local depois.
      if (novo === 'closed') {
        db.prepare("UPDATE ml_anuncios SET status='encerrado', dataAtualizacao=CURRENT_TIMESTAMP WHERE id=?").run(a.id);
      }
      res.json({ success: true, status: j?.status || novo,
                 subStatus: Array.isArray(j?.sub_status) ? j.sub_status : [] });
    } catch (e) { res.status(400).json({ success: false, error: e.message }); }
  });

  // Validação no próprio ML, sem criar anúncio. É o que responde "isto vai
  // ser aceito?" antes de descobrir na recusa.
  app.post('/api/marketplaces/ml/anuncios/:id/validar', async (req, res) => {
    try {
      const a = db.prepare('SELECT * FROM ml_anuncios WHERE id = ?').get(req.params.id);
      if (!a) return res.status(404).json({ success: false, error: 'Rascunho não encontrado' });
      const token = await getAccessTokenValido(db, console.log);
      if (!token) return res.status(400).json({ success: false, error: 'Sem token do Mercado Livre — reconecte a integração' });
      const produto = db.prepare('SELECT * FROM produtos WHERE id = ?').get(a.produtoId);
      const r = await anuncios.prepararCorpo(a, produto, { token });
      res.json({ success: true, erros: r.erros, avisos: r.avisos, porFamilia: r.porFamilia });
    } catch (e) { res.status(400).json({ success: false, error: e.message }); }
  });

  // Pesquisa de preço: consulta anúncios ativos do ML e devolve a faixa
  // praticada. Não grava nada — quem decide o preço é quem está olhando.
  app.post('/api/marketplaces/ml/anuncios/:id/sugerir-preco', async (req, res) => {
    try {
      let token = null;
      try { token = await getAccessTokenValido(db, console.log); } catch { }
      const r = await anuncios.sugerirPrecoMercado(db, Number(req.params.id),
        { token, keys: chavesIA(), log: console.log });
      res.json({ success: true, ...r });
    } catch (e) { res.status(400).json({ success: false, error: e.message }); }
  });

  // Geração em lote. Cada produto é independente: um erro não derruba os
  // outros, e o motivo volta produto a produto.
  app.post('/api/marketplaces/ml/anuncios/gerar', async (req, res) => {
    try {
      const ids = Array.isArray(req.body?.produtoIds) ? req.body.produtoIds.map(Number).filter(Boolean) : [];
      if (!ids.length) return res.status(400).json({ success: false, error: 'Informe produtoIds' });
      if (ids.length > 50) return res.status(400).json({ success: false, error: 'No máximo 50 produtos por vez' });

      const keys = chavesIA();
      if (!Object.values(keys).some(Boolean)) {
        return res.status(400).json({ success: false, error: 'Nenhuma chave de IA configurada — cadastre em Configurações' });
      }
      const baseUrl = baseUrlDe(req);
      // Token opcional aqui: sem ele o catálogo ainda responde, só com menos
      // dado. Não vale bloquear a geração de rascunho por causa disso.
      let token = null;
      try { token = await getAccessTokenValido(db, console.log); } catch { }
      const ok = [], falhas = [];
      for (const id of ids) {
        try {
          const r = await anuncios.gerarRascunho(db, id, { keys, baseUrl, token, log: console.log });
          ok.push({ produtoId: id, sku: r.sku, titulo: r.titulo, bloqueios: r.bloqueios,
                    geradoPor: r.geradoPor, faltandoIA: r.faltandoIA, catalogo: r.catalogo });
        } catch (e) {
          falhas.push({ produtoId: id, erro: e.message });
        }
      }
      res.json({ success: true, gerados: ok.length, falhas, rascunhos: ok });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  app.put('/api/marketplaces/ml/anuncios/:id', (req, res) => {
    try {
      const a = db.prepare('SELECT * FROM ml_anuncios WHERE id = ?').get(req.params.id);
      if (!a) return res.status(404).json({ success: false, error: 'Rascunho não encontrado' });
      if (a.status === 'publicado') {
        return res.status(400).json({ success: false, error: 'Anúncio já publicado — altere pelo Mercado Livre' });
      }
      const b = req.body || {};
      const titulo = b.titulo != null ? String(b.titulo).trim() : a.titulo;
      if (titulo && titulo.length > anuncios.MAX_TITULO) {
        return res.status(400).json({ success: false,
          error: `Título com ${titulo.length} caracteres — o Mercado Livre aceita ${anuncios.MAX_TITULO}` });
      }
      db.prepare(`UPDATE ml_anuncios SET titulo=?, descricao=?, preco=?, quantidade=?,
          listingTypeId=?, condicao=?, atributos=?, status='rascunho', erro=NULL,
          dataAtualizacao=CURRENT_TIMESTAMP WHERE id=?`)
        .run(titulo, b.descricao != null ? String(b.descricao) : a.descricao,
             b.preco != null ? Number(b.preco) : a.preco,
             b.quantidade != null ? Math.max(0, Math.floor(Number(b.quantidade))) : a.quantidade,
             b.listingTypeId || a.listingTypeId, b.condicao || a.condicao,
             b.atributos ? JSON.stringify(b.atributos) : a.atributos, a.id);
      res.json({ success: true, anuncio: db.prepare('SELECT * FROM ml_anuncios WHERE id = ?').get(a.id) });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  app.post('/api/marketplaces/ml/anuncios/:id/publicar', async (req, res) => {
    try {
      const token = await getAccessTokenValido(db, console.log);
      const r = await anuncios.publicarRascunho(db, Number(req.params.id),
        { token, log: console.log, usuario: req.session?.username || null, raizPublica: RAIZ_PUBLICA });
      res.json({ success: true, ...r });
    } catch (e) { res.status(400).json({ success: false, error: e.message }); }
  });

  app.post('/api/marketplaces/ml/anuncios/publicar-lote', async (req, res) => {
    try {
      const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Boolean) : [];
      if (!ids.length) return res.status(400).json({ success: false, error: 'Informe ids' });
      const token = await getAccessTokenValido(db, console.log);
      if (!token) return res.status(400).json({ success: false, error: 'Sem token do Mercado Livre' });
      const ok = [], falhas = [];
      for (const id of ids) {
        try {
          const r = await anuncios.publicarRascunho(db, id, { token, log: console.log,
            usuario: req.session?.username || null, raizPublica: RAIZ_PUBLICA });
          ok.push({ id, ...r });
        } catch (e) { falhas.push({ id, erro: e.message }); }
      }
      res.json({ success: true, publicados: ok.length, ok, falhas });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  // Sugestões para o cadastro do produto: catálogo do ML (confiável), conta de
  // markup (determinística) e IA (estimativa). Só sugere — gravar é outro passo.
  app.get('/api/marketplaces/ml/produtos/:id/sugestoes', async (req, res) => {
    try {
      let token = null;
      try { token = await getAccessTokenValido(db, console.log); } catch { }
      const r = await anuncios.sugerirDadosProduto(db, Number(req.params.id),
        { keys: chavesIA(), token, log: console.log });
      res.json({ success: true, ...r });
    } catch (e) { res.status(400).json({ success: false, error: e.message }); }
  });

  app.post('/api/marketplaces/ml/produtos/:id/aplicar-sugestoes', (req, res) => {
    try {
      const r = anuncios.aplicarSugestoes(db, Number(req.params.id), req.body?.campos || {},
        { usuario: req.session?.username || null });
      res.json({ success: true, ...r });
    } catch (e) { res.status(400).json({ success: false, error: e.message }); }
  });

  // Código de barras: a IA propõe, o dígito verificador e o catálogo do ML
  // conferem. Rota própria de propósito — fora de CAMPOS_SUGERIVEIS, para que
  // o "Completar cadastro" não passe a chutar GTIN sem essa verificação.
  app.post('/api/marketplaces/ml/produtos/:id/procurar-gtin', async (req, res) => {
    try {
      let token = null;
      try { token = await getAccessTokenValido(db, console.log); } catch { }
      const r = await anuncios.procurarGtin(db, Number(req.params.id),
        { keys: chavesIA(), token, log: console.log });
      res.json({ success: true, ...r });
    } catch (e) { res.status(400).json({ success: false, error: e.message }); }
  });

  // Varredura: todo produto sem código de barras que tenha nota de entrada com
  // EAN. Fonte factual e de graça — nem IA, nem chamada externa por produto.
  app.post('/api/marketplaces/ml/produtos/gtin-das-notas', (req, res) => {
    try {
      const semGtin = db.prepare(`SELECT id, sku FROM produtos
        WHERE ativo = 1 AND TRIM(COALESCE(codigoBarras,'')) = ''`).all();
      const aplicados = [], recusados = [];
      for (const p of semGtin) {
        const [nota] = anuncios.gtinDasNotas(db, p.id);
        if (!nota) continue;
        const cod = String(nota.ean).replace(/\D/g, '');
        if (!anuncios.digitoGtinOk(cod)) {
          recusados.push({ sku: p.sku, ean: cod, motivo: 'dígito verificador não fecha' });
          continue;
        }
        if (!req.body?.simular) {
          db.prepare('UPDATE produtos SET codigoBarras = ?, dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?')
            .run(cod, p.id);
        }
        aplicados.push({ sku: p.sku, ean: cod, nota: nota.numero, fornecedor: nota.emitenteRazaoSocial });
      }
      res.json({ success: true, simulado: !!req.body?.simular,
                 candidatos: semGtin.length, aplicados, recusados });
    } catch (e) { res.status(400).json({ success: false, error: e.message }); }
  });

  // Gravação do código de barras. Só entra o que fecha o dígito verificador:
  // número que não fecha não existe como GTIN, e o ML recusaria depois.
  app.post('/api/marketplaces/ml/produtos/:id/codigo-barras', (req, res) => {
    try {
      const cod = String(req.body?.codigoBarras || '').replace(/\D/g, '');
      if (!anuncios.digitoGtinOk(cod)) {
        return res.status(400).json({ success: false,
          error: 'Código de barras inválido: o dígito verificador não fecha' });
      }
      const p = db.prepare('SELECT id FROM produtos WHERE id = ?').get(Number(req.params.id));
      if (!p) return res.status(404).json({ success: false, error: 'Produto não encontrado' });
      db.prepare('UPDATE produtos SET codigoBarras = ?, dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?')
        .run(cod, p.id);
      res.json({ success: true, codigoBarras: cod });
    } catch (e) { res.status(400).json({ success: false, error: e.message }); }
  });

  // Lote: varre os produtos com buraco no cadastro e devolve o que dá para
  // preencher. Não grava nada — é o painel de "o que falta para anunciar".
  app.post('/api/marketplaces/ml/produtos/sugestoes-lote', async (req, res) => {
    try {
      const ids = Array.isArray(req.body?.produtoIds) ? req.body.produtoIds.map(Number).filter(Boolean) : [];
      if (!ids.length) return res.status(400).json({ success: false, error: 'Informe produtoIds' });
      if (ids.length > 30) return res.status(400).json({ success: false, error: 'No máximo 30 por vez' });
      let token = null;
      try { token = await getAccessTokenValido(db, console.log); } catch { }
      const keys = chavesIA();
      const out = [], falhas = [];
      for (const id of ids) {
        try { out.push(await anuncios.sugerirDadosProduto(db, id, { keys, token, log: console.log })); }
        catch (e) { falhas.push({ produtoId: id, erro: e.message }); }
      }
      res.json({ success: true, produtos: out, falhas,
        comCatalogo: out.filter(x => x.fotoResolvidaPeloCatalogo).length });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  app.delete('/api/marketplaces/ml/anuncios/:id', (req, res) => {
    try {
      const a = db.prepare('SELECT status FROM ml_anuncios WHERE id = ?').get(req.params.id);
      if (!a) return res.status(404).json({ success: false, error: 'Rascunho não encontrado' });
      if (a.status === 'publicado') {
        return res.status(400).json({ success: false,
          error: 'Anúncio no ar não some daqui — encerre no Mercado Livre primeiro' });
      }
      db.prepare('DELETE FROM ml_anuncios WHERE id = ?').run(req.params.id);
      res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });
}

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

  // Webhook de notificações (apex, público). O ML exige resposta 200 em <500ms senão
  // re-tenta — respondemos JÁ e processamos async. Resolve o tenant pelo user_id.
  app.post('/api/marketplaces/ml/webhook', (req, res) => {
    res.status(200).end();
    const notif = req.body || {};
    setImmediate(() => {
      processarNotificacao(notif, tenantManager, (m) => console.log(m))
        .catch(e => console.error('[ML webhook]', e.message));
    });
  });
}

module.exports = {
  registrarRotasTenant,
  registrarRotasGlobal,
  migrarSchemaTenant,
  refreshVencendo,
  configOk,
  importarPedido,
  processarNotificacao,
  getAccessTokenValido,
  resolverTenantPorUserId,
  sincronizarItensML,
  pushEstoqueML,
  emitirNfeDoPedidoML,
  buscarBillingInfo,
  // expostos p/ teste
  _internal: { cifrar, decifrar, gerarPKCE, gerarState, buildAuthorizeUrl, mlConfig },
};
