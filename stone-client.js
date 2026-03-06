/**
 * stone-client.js — Cliente API Stone para emissão de boletos bancários
 *
 * Uso:
 *   const { StoneClient, loadStoneConfig } = require('./stone-client');
 *   const config = loadStoneConfig(db);
 *   if (config) {
 *     const client = new StoneClient(config);
 *     const boleto = await client.criarBoleto({ amount, expirationDate, customerDocument, customerName });
 *   }
 */

const crypto = require('crypto');
const https = require('https');

const URLS = {
  sandbox: {
    auth: 'https://sandbox-accounts.openbank.stone.com.br/auth/realms/stone_bank/protocol/openid-connect/token',
    api: 'https://sandbox-api.openbank.stone.com.br/api/v1',
  },
  production: {
    auth: 'https://accounts.openbank.stone.com.br/auth/realms/stone_bank/protocol/openid-connect/token',
    api: 'https://api.openbank.stone.com.br/api/v1',
  },
};

class StoneClient {
  /**
   * @param {{ clientId: string, accountId: string, privateKeyPem: string, ambiente: string }} opts
   */
  constructor({ clientId, accountId, privateKeyPem, ambiente = 'sandbox' }) {
    this.clientId = clientId;
    this.accountId = accountId;
    this.privateKeyPem = privateKeyPem;
    this.ambiente = ambiente;
    this.urls = URLS[ambiente] || URLS.sandbox;
    this._accessToken = null;
    this._tokenExpiry = 0;
  }

  /** Verifica se tem credenciais mínimas configuradas */
  isConfigured() {
    return !!(this.clientId && this.accountId && this.privateKeyPem);
  }

  /** Gera JWT assinado com RS256 para autenticação Stone */
  _generateJWT() {
    const now = Math.floor(Date.now() / 1000);

    const header = { alg: 'RS256', typ: 'JWT' };
    const payload = {
      sub: this.clientId,
      clientId: this.clientId,
      aud: 'accounts.openbank.stone.com.br',
      iss: this.clientId,
      iat: now,
      exp: now + 900, // 15 minutos
      jti: crypto.randomUUID(),
      realm: 'stone_bank',
    };

    const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
    const unsigned = `${b64(header)}.${b64(payload)}`;

    const sign = crypto.createSign('RSA-SHA256');
    sign.update(unsigned);
    const signature = sign.sign(this.privateKeyPem, 'base64url');

    return `${unsigned}.${signature}`;
  }

  /** Obtém access_token via client_credentials + JWT assertion */
  async _authenticate() {
    const jwt = this._generateJWT();

    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.clientId,
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion: jwt,
    }).toString();

    const resp = await this._rawRequest('POST', this.urls.auth, body, {
      'Content-Type': 'application/x-www-form-urlencoded',
    });

    if (!resp.access_token) {
      throw new Error(`Stone auth falhou: ${JSON.stringify(resp)}`);
    }

    this._accessToken = resp.access_token;
    this._tokenExpiry = Date.now() + 14 * 60 * 1000; // cache 14 min
    return this._accessToken;
  }

  /** Retorna token válido (cache 14min) */
  async _getToken() {
    if (this._accessToken && Date.now() < this._tokenExpiry) {
      return this._accessToken;
    }
    return this._authenticate();
  }

  /** Requisição HTTPS genérica */
  _rawRequest(method, url, body, headers = {}) {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const options = {
        hostname: parsed.hostname,
        port: parsed.port || 443,
        path: parsed.pathname + parsed.search,
        method,
        headers: { ...headers },
        timeout: 30000,
      };

      const req = https.request(options, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf-8');
          try {
            const json = JSON.parse(raw);
            if (res.statusCode >= 400) {
              const err = new Error(`Stone API ${res.statusCode}: ${raw.substring(0, 500)}`);
              err.statusCode = res.statusCode;
              err.response = json;
              reject(err);
            } else {
              resolve(json);
            }
          } catch {
            if (res.statusCode >= 400) {
              reject(new Error(`Stone API ${res.statusCode}: ${raw.substring(0, 500)}`));
            } else {
              resolve(raw);
            }
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Stone API timeout (30s)')); });

      if (body) req.write(body);
      req.end();
    });
  }

  /** Requisição autenticada à API Stone */
  async _apiRequest(method, path, body = null) {
    const token = await this._getToken();
    const url = `${this.urls.api}${path}`;
    const headers = {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'x-stone-account-id': this.accountId,
    };
    return this._rawRequest(method, url, body ? JSON.stringify(body) : null, headers);
  }

  /**
   * Criar boleto
   * @param {{ amount: number, expirationDate: string, customerDocument: string, customerName: string }} dados
   * @returns {{ id, barcode, writable_line, status, ... }}
   */
  async criarBoleto({ amount, expirationDate, customerDocument, customerName }) {
    const payload = {
      account_id: this.accountId,
      amount,
      expiration_date: expirationDate,
      invoice_type: 'deposit',
      customer: {
        document: customerDocument.replace(/\D/g, ''),
        name: customerName,
      },
    };

    return this._apiRequest('POST', '/barcode_payment_invoices', payload);
  }

  /** Consultar boleto pelo ID Stone */
  async consultarBoleto(stoneId) {
    return this._apiRequest('GET', `/barcode_payment_invoices/${stoneId}`);
  }

  /** Cancelar boleto pelo ID Stone */
  async cancelarBoleto(stoneId) {
    return this._apiRequest('DELETE', `/barcode_payment_invoices/${stoneId}`);
  }
}

/**
 * Lê stone_config do banco e retorna objeto de configuração ou null se não configurada
 */
function loadStoneConfig(db) {
  try {
    const rows = db.prepare('SELECT key, value FROM stone_config').all();
    if (!rows.length) return null;

    const config = {};
    for (const row of rows) {
      config[row.key] = row.value;
    }

    if (!config.client_id || !config.account_id || !config.private_key_pem) {
      return null;
    }

    return {
      clientId: config.client_id,
      accountId: config.account_id,
      privateKeyPem: config.private_key_pem,
      ambiente: config.ambiente || 'sandbox',
    };
  } catch {
    return null;
  }
}

module.exports = { StoneClient, loadStoneConfig };
