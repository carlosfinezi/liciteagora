/**
 * mercadopago-client.js — Cliente API MercadoPago para boletos
 *
 * Uso:
 *   const { MercadoPagoClient, loadMPConfig } = require('./mercadopago-client');
 *   const config = loadMPConfig(db);
 *   if (config) {
 *     const client = new MercadoPagoClient(config);
 *     const boleto = await client.criarBoleto({ ... });
 *   }
 */

const https = require('https');

const API_URL = 'https://api.mercadopago.com';

class MercadoPagoClient {
  constructor({ accessToken }) {
    this.accessToken = accessToken;
  }

  isConfigured() {
    return !!this.accessToken;
  }

  _request(method, path, body = null) {
    return new Promise((resolve, reject) => {
      const url = new URL(path, API_URL);
      const options = {
        hostname: url.hostname,
        port: 443,
        path: url.pathname + url.search,
        method,
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json',
          'X-Idempotency-Key': `${Date.now()}-${Math.random().toString(36).substring(2, 10)}`,
        },
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
              const msg = json.message || json.error || raw.substring(0, 300);
              const err = new Error(`MercadoPago ${res.statusCode}: ${msg}`);
              err.statusCode = res.statusCode;
              err.response = json;
              reject(err);
            } else {
              resolve(json);
            }
          } catch {
            if (res.statusCode >= 400) {
              reject(new Error(`MercadoPago ${res.statusCode}: ${raw.substring(0, 300)}`));
            } else {
              resolve(raw);
            }
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('MercadoPago API timeout (30s)')); });

      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }

  /**
   * Criar boleto via Payment API
   * @param {{ amount: number, description: string, expirationDate: string, customerDocument: string, customerName: string, customerEmail: string }} dados
   *   amount em REAIS (ex: 782.87), expirationDate formato YYYY-MM-DD
   * @returns {{ id, barcode, externalResourceUrl, writableLine, status, ... }}
   */
  async criarBoleto({ amount, description, expirationDate, customerDocument, customerName, customerEmail, address, nfseNumero, competencia }) {
    const doc = (customerDocument || '').replace(/\D/g, '');
    const docType = doc.length <= 11 ? 'CPF' : 'CNPJ';

    // Converter expirationDate para ISO 8601 com timezone
    const expDate = new Date(expirationDate + 'T23:59:59.000-03:00').toISOString();

    // Formatar documento com pontuação
    const docFmt = doc.length <= 11
      ? doc.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4')
      : doc.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');

    const addr = address || {};
    const enderecoCompleto = [addr.endereco, addr.numero, addr.bairro, addr.cidade, addr.uf].filter(Boolean).join(', ');

    const payload = {
      transaction_amount: amount,
      description: description || 'Boleto',
      payment_method_id: 'bolbradesco',
      date_of_expiration: expDate,
      payer: {
        email: customerEmail || 'pagador@email.com',
        first_name: customerName || 'Cliente',
        last_name: docType === 'CPF' ? (customerName?.split(' ').slice(1).join(' ') || '') : '',
        identification: {
          type: docType,
          number: doc,
        },
        address: {
          zip_code: (addr.cep || '00000000').replace(/\D/g, ''),
          street_name: addr.endereco || 'Nao informado',
          street_number: addr.numero || 'S/N',
          neighborhood: addr.bairro || 'Centro',
          city: addr.cidade || 'Nao informado',
          federal_unit: addr.uf || 'SP',
        },
      },
      additional_info: {
        items: [{
          id: nfseNumero || 'boleto',
          title: description || 'Servico',
          quantity: 1,
          unit_price: amount,
        }],
        payer: {
          first_name: customerName || 'Cliente',
          last_name: docType === 'CPF' ? (customerName?.split(' ').slice(1).join(' ') || '') : '',
          registration_date: new Date().toISOString(),
          phone: { area_code: '', number: '' },
          address: {
            zip_code: (addr.cep || '').replace(/\D/g, ''),
            street_name: addr.endereco || '',
            street_number: parseInt(addr.numero) || 0,
          },
        },
      },
      metadata: {
        sacado: customerName || '',
        documento: docFmt,
        endereco: enderecoCompleto,
        nfse: nfseNumero || '',
        competencia: competencia || '',
      },
    };

    const resp = await this._request('POST', '/v1/payments', payload);

    const td = resp.transaction_details || {};
    const barcode = td.barcode?.content || resp.barcode?.content || '';
    const writableLine = td.digitable_line || resp.barcode?.digitable_line || '';
    const externalUrl = td.external_resource_url || '';

    return {
      id: String(resp.id),
      barcode,
      writable_line: writableLine,
      external_resource_url: externalUrl,
      status: resp.status,
      status_detail: resp.status_detail,
      raw: resp,
    };
  }

  /** Consultar pagamento pelo ID */
  async consultarBoleto(paymentId) {
    return this._request('GET', `/v1/payments/${paymentId}`);
  }

  /** Cancelar pagamento pelo ID */
  async cancelarBoleto(paymentId) {
    return this._request('PUT', `/v1/payments/${paymentId}`, { status: 'cancelled' });
  }

  /** Testar conexao — busca dados da conta */
  async testarConexao() {
    return this._request('GET', '/users/me');
  }
}

/**
 * Le mp_config do banco e retorna objeto de configuracao ou null
 */
function loadMPConfig(db) {
  try {
    const rows = db.prepare('SELECT key, value FROM mp_config').all();
    if (!rows.length) return null;

    const config = {};
    for (const row of rows) config[row.key] = row.value;

    if (!config.access_token) return null;

    return { accessToken: config.access_token };
  } catch {
    return null;
  }
}

module.exports = { MercadoPagoClient, loadMPConfig };
