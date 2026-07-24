/**
 * sc-client.js — Cliente HTTP para o portal de Cotação Eletrônica de SC.
 *
 * Frontend público:  https://cotacao.licitacao.sc.gov.br
 * Backend (CIASC/OKD4): https://cotacao-backend-cotacao-eletronica.prod.okd4.ciasc.sc.gov.br
 *
 * Auth: OAuth2 password grant. POST /oauth/token retorna JWT bearer com
 * expires_in ≈ 10799s (~3h). Sem captcha, sem MFA, sem cookie. Padrão
 * "login direto pelo servidor" — o servidor guarda o token em config e
 * envia Authorization: Bearer <token> nas chamadas autenticadas.
 *
 * Token e credenciais persistem em config (mesma tabela KV usada por
 * credenciais-routes.js). Chaves:
 *   sc_usuario          — CNPJ do fornecedor (texto puro, igual Comprasnet)
 *   sc_senha            — senha (texto puro, igual padrão atual do app)
 *   sc_access_token     — JWT bearer obtido no /oauth/token
 *   sc_token_expires_at — epoch ms de expiração calculada
 *   sc_usuario_json     — JSON do bloco "usuario" da resposta de login
 */

const axios = require('axios');
const https = require('https');

const BASE_URL = 'https://cotacao-backend-cotacao-eletronica.prod.okd4.ciasc.sc.gov.br';
const FRONTEND_URL = 'https://cotacao.licitacao.sc.gov.br';

// OAuth2 client credentials extraídos do bundle Angular do frontend
// (`Basic YW5ndWxhcjpAbmd1bEByMA==` em main.6701ff83386b8408.js).
// Não é segredo: qualquer usuário do portal os vê no DevTools.
const OAUTH_CLIENT_ID = 'angular';
const OAUTH_CLIENT_SECRET = '@ngul@r0';
const OAUTH_BASIC_AUTH = 'Basic ' + Buffer.from(`${OAUTH_CLIENT_ID}:${OAUTH_CLIENT_SECRET}`).toString('base64');

// Pool TLS reutilizável — futuras fases (sync 30s, sniper) batem com frequência.
const keepAliveAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 20,
  maxFreeSockets: 10,
  timeout: 60000,
});

const TOKEN_TTL_DEFAULT_S = 10799;
// Renova token se faltar menos de 10 min pra expirar.
const TOKEN_SAFE_MARGIN_MS = 600 * 1000;

const COMMON_HEADERS = {
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
  'Origin': FRONTEND_URL,
  'Referer': `${FRONTEND_URL}/`,
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
};

/**
 * Extrai o valor do cookie refreshToken de um header Set-Cookie (string ou array).
 * O backend SC emite "refreshToken=eyJ...; Max-Age=2592000; Path=/oauth/token; HttpOnly".
 */
function parseRefreshTokenFromSetCookie(setCookieHeader) {
  if (!setCookieHeader) return null;
  const cookies = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  for (const c of cookies) {
    const m = /(?:^|;\s*)refreshToken=([^;]+)/.exec(c);
    if (m) return m[1];
  }
  return null;
}

class SCClient {
  constructor(db) {
    this.db = db;
    this.accessToken = null;
    this.tokenExpiresAt = null;
    this.usuario = null;
    this._restaurarToken();
  }

  log(msg) {
    const ts = new Date().toLocaleTimeString('pt-BR', { hour12: false });
    console.log(`[SC ${ts}] ${msg}`);
  }

  _getConfig(chave) {
    try {
      const row = this.db.prepare('SELECT valor FROM config WHERE chave = ?').get(chave);
      return row ? row.valor : null;
    } catch (_) {
      return null;
    }
  }

  _setConfig(chave, valor) {
    try {
      this.db.prepare(
        `INSERT OR REPLACE INTO config (chave, valor, dataAtualizacao) VALUES (?, ?, CURRENT_TIMESTAMP)`
      ).run(chave, valor);
    } catch (e) {
      this.log(`Erro ao salvar config ${chave}: ${e.message}`);
    }
  }

  _restaurarToken() {
    const tok = this._getConfig('sc_access_token');
    const exp = this._getConfig('sc_token_expires_at');
    const usu = this._getConfig('sc_usuario_json');
    if (!tok || !exp) return;
    const expiresAt = parseInt(exp, 10);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() + TOKEN_SAFE_MARGIN_MS) {
      this.log('Token persistido vencido/perto de vencer — login será refeito sob demanda');
      return;
    }
    this.accessToken = tok;
    this.tokenExpiresAt = expiresAt;
    if (usu) {
      try { this.usuario = JSON.parse(usu); } catch (_) {}
    }
    const restantes = Math.floor((expiresAt - Date.now()) / 1000);
    this.log(`Token restaurado do banco (válido por ~${restantes}s)`);
  }

  tokenValido() {
    return !!this.accessToken
      && Number.isFinite(this.tokenExpiresAt)
      && this.tokenExpiresAt > Date.now() + TOKEN_SAFE_MARGIN_MS;
  }

  /**
   * Login via OAuth2 password grant. Persiste access_token + refresh_token + bloco usuario.
   * O endpoint exige Basic Auth do client (angular:@ngul@r0) — extraído do bundle Angular.
   * Resposta também devolve refreshToken num Set-Cookie (Max-Age=2592000s, ~30d).
   */
  async login(cnpj, senha) {
    if (!cnpj || !senha) throw new Error('CNPJ e senha obrigatórios');
    return await this._postOauthToken({ grant_type: 'password', username: cnpj, password: senha });
  }

  /**
   * Renova token usando refresh_token salvo. Não exige senha.
   */
  async refresh() {
    const refreshToken = this._getConfig('sc_refresh_token');
    if (!refreshToken) throw new Error('Sem refresh_token persistido');
    return await this._postOauthToken({ grant_type: 'refresh_token', refresh_token: refreshToken });
  }

  async _postOauthToken(params) {
    const body = new URLSearchParams(params).toString();
    let resp;
    try {
      resp = await axios.post(`${BASE_URL}/oauth/token`, body, {
        headers: {
          ...COMMON_HEADERS,
          'Authorization': OAUTH_BASIC_AUTH,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        timeout: 15000,
        validateStatus: () => true,
        httpsAgent: keepAliveAgent,
      });
    } catch (e) {
      throw new Error(`Falha de rede no /oauth/token: ${e.message}`);
    }

    if (resp.status !== 200) {
      const detalhe = typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data || {});
      throw new Error(`/oauth/token grant=${params.grant_type} falhou (HTTP ${resp.status}): ${detalhe.substring(0, 300)}`);
    }
    const data = resp.data || {};
    if (!data.access_token) throw new Error('Resposta de /oauth/token sem access_token');

    const expiresIn = Number.isFinite(data.expires_in) ? data.expires_in : TOKEN_TTL_DEFAULT_S;
    this.accessToken = data.access_token;
    this.tokenExpiresAt = Date.now() + expiresIn * 1000;
    this.usuario = data.usuario || null;

    this._setConfig('sc_access_token', this.accessToken);
    this._setConfig('sc_token_expires_at', String(this.tokenExpiresAt));
    if (this.usuario) this._setConfig('sc_usuario_json', JSON.stringify(this.usuario));

    // refresh_token vem no body (alguns Spring) ou no Set-Cookie (refreshToken=...).
    const refreshFromBody = data.refresh_token;
    const refreshFromCookie = parseRefreshTokenFromSetCookie(resp.headers && resp.headers['set-cookie']);
    const refreshToken = refreshFromBody || refreshFromCookie;
    if (refreshToken) {
      this._setConfig('sc_refresh_token', refreshToken);
    }

    this.log(`Token OK via grant=${params.grant_type} (expira em ${expiresIn}s${refreshToken ? ', refresh_token salvo' : ''})`);
    return { ok: true, expiresIn, usuario: this.usuario };
  }

  async loginComCredenciaisSalvas() {
    const cnpj = this._getConfig('sc_usuario');
    const senha = this._getConfig('sc_senha');
    if (!cnpj || !senha) {
      throw new Error('Credenciais SC não cadastradas (POST /api/sc/credenciais)');
    }
    return await this.login(cnpj, senha);
  }

  /**
   * Garante token válido. Tenta refresh_token (não usa senha) antes de re-logar.
   */
  async ensureToken() {
    if (this.tokenValido()) return;
    if (this._getConfig('sc_refresh_token')) {
      try {
        await this.refresh();
        return;
      } catch (e) {
        this.log(`refresh falhou (${e.message}) — caindo pra login com senha`);
      }
    }
    await this.loginComCredenciaisSalvas();
  }

  forceExpireToken() {
    this.accessToken = null;
    this.tokenExpiresAt = null;
    this._setConfig('sc_access_token', '');
    this._setConfig('sc_token_expires_at', '0');
  }

  async _request(method, path, options = {}) {
    if (!options._jaTentouRelogar) {
      await this.ensureToken();
    }
    const url = path.startsWith('http') ? path : `${BASE_URL}${path}`;
    const config = {
      method,
      url,
      headers: {
        ...COMMON_HEADERS,
        Authorization: `Bearer ${this.accessToken}`,
        ...(options.headers || {}),
      },
      timeout: options.timeout || 15000,
      validateStatus: () => true,
      httpsAgent: keepAliveAgent,
    };
    if (options.data !== undefined) config.data = options.data;
    if (options.params) config.params = options.params;

    const resp = await axios(config);

    if ((resp.status === 401 || resp.status === 403) && !options._jaTentouRelogar) {
      this.log(`HTTP ${resp.status} em ${path} → invalidando token e relogando`);
      this.forceExpireToken();
      try {
        await this.loginComCredenciaisSalvas();
      } catch (e) {
        this.log(`Re-login falhou: ${e.message}`);
        return resp;
      }
      return await this._request(method, path, { ...options, _jaTentouRelogar: true });
    }
    return resp;
  }

  apiGet(path, options = {}) { return this._request('GET', path, options); }
  apiPost(path, data, options = {}) { return this._request('POST', path, { ...options, data }); }
  apiPut(path, data, options = {}) { return this._request('PUT', path, { ...options, data }); }
  apiDelete(path, options = {}) { return this._request('DELETE', path, options); }

  /**
   * Bate em /api/dispensas-licitacao/data-atual-servidor — endpoint dedicado de
   * keepalive (descoberto no HAR de 2026-04-30, retorna apenas string ISO da hora
   * do servidor CIASC). Mais leve que paginar a listagem.
   */
  async validarSessao() {
    try {
      const resp = await this.apiGet('/api/dispensas-licitacao/data-atual-servidor');
      return {
        valid: resp.status === 200,
        status: resp.status,
        dataServidor: typeof resp.data === 'string' ? resp.data : null,
      };
    } catch (e) {
      return { valid: false, status: null, error: e.message };
    }
  }
}

module.exports = { SCClient, BASE_URL, FRONTEND_URL };
