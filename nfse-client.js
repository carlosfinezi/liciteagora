/**
 * nfse-client.js — Cliente HTTP com mTLS para API do Emissor Nacional (NFS-e)
 *
 * Uso no nfse-routes.js:
 *   const { NfseClient } = require('./nfse-client');
 *   const client = new NfseClient(p12Buffer, senha, tpAmb);
 */

const https = require('https');
const zlib = require('zlib');

const URLS = {
  1: 'https://sefin.nfse.gov.br/SefinNacional',           // Produção
  2: 'https://sefin.producaorestrita.nfse.gov.br/SefinNacional',  // Homologação
};

// URLs alternativas (API)
const URLS_API = {
  1: 'https://sefin.nfse.gov.br/API/SefinNacional',
  2: 'https://sefin.producaorestrita.nfse.gov.br/API/SefinNacional',
};

// NFSE-H09: códigos/erros considerados transientes para retry automático
const TRANSIENT_STATUS = new Set([502, 503, 504]);
const TRANSIENT_ERR_CODES = new Set([
  'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE',
]);

function _isTransientErr(err) {
  if (!err) return false;
  if (err.code && TRANSIENT_ERR_CODES.has(err.code)) return true;
  const msg = String(err.message || err).toLowerCase();
  return /timeout|socket hang up|econnreset|etimedout|network/.test(msg);
}

function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

class NfseClient {
  /**
   * @param {Buffer} p12Buffer - Certificado PKCS#12 como Buffer
   * @param {string} senha - Senha do certificado
   * @param {number} tpAmb - 1=Produção, 2=Homologação
   */
  constructor(p12Buffer, senha, tpAmb = 2) {
    this.tpAmb = tpAmb;
    this.baseUrl = URLS[tpAmb] || URLS[2];
    this.baseUrlApi = URLS_API[tpAmb] || URLS_API[2];

    this.agent = new https.Agent({
      pfx: p12Buffer,
      passphrase: senha,
      rejectUnauthorized: true,
    });
  }

  /**
   * NFSE-H09: wrapper com retry exponencial + jitter APENAS para métodos
   * idempotentes (GET). POST (emitirNfse, cancelarNfse) NUNCA faz retry
   * automático — risco de dupla emissão fiscal enquanto NFSE-C03 (idempotency
   * key full) não estiver completa.
   */
  async _requestWithRetry(method, url, body, headers = {}, opts = {}) {
    const isIdempotent = method === 'GET' || opts.forceRetry === true;
    if (!isIdempotent) return this._request(method, url, body, headers);

    const maxTries = 3; // 1 tentativa + 2 retries
    const baseDelays = [0, 1000, 3000];
    let lastErr;
    for (let attempt = 0; attempt < maxTries; attempt++) {
      if (attempt > 0) {
        const jitter = Math.floor(Math.random() * 250);
        await _sleep(baseDelays[attempt] + jitter);
        console.log(`[NFSe][retry] tentativa ${attempt + 1}/${maxTries} em ${method} ${url}`);
      }
      try {
        const resp = await this._request(method, url, body, headers);
        if (TRANSIENT_STATUS.has(resp.status) && attempt < maxTries - 1) {
          lastErr = new Error(`SEFIN transiente ${resp.status}`);
          continue;
        }
        return resp;
      } catch (err) {
        lastErr = err;
        if (!_isTransientErr(err) || attempt >= maxTries - 1) throw err;
      }
    }
    throw lastErr || new Error('retry exaurido sem causa');
  }

  /**
   * Faz requisição HTTPS com mTLS
   */
  _request(method, url, body, headers = {}) {
    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url);

      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || 443,
        path: parsedUrl.pathname + parsedUrl.search,
        method,
        agent: this.agent,
        headers: {
          'Accept': 'application/json',
          ...headers,
        },
      };

      if (body) {
        if (typeof body === 'string') {
          options.headers['Content-Type'] = 'application/json';
          options.headers['Content-Length'] = Buffer.byteLength(body);
        } else if (Buffer.isBuffer(body)) {
          options.headers['Content-Length'] = body.length;
        }
      }

      const req = https.request(options, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const rawBody = Buffer.concat(chunks);
          const contentType = res.headers['content-type'] || '';

          let parsed;
          if (contentType.includes('application/json')) {
            try {
              parsed = JSON.parse(rawBody.toString('utf-8'));
            } catch {
              parsed = rawBody.toString('utf-8');
            }
          } else if (contentType.includes('application/pdf')) {
            parsed = rawBody; // Buffer do PDF
          } else {
            parsed = rawBody.toString('utf-8');
          }

          resolve({
            status: res.statusCode,
            headers: res.headers,
            data: parsed,
          });
        });
      });

      req.on('error', (err) => {
        // NFSE-H09: preserva err.code para que retry detecte transientes
        const wrapped = new Error(`Erro na requisição SEFIN: ${err.message}`);
        if (err.code) wrapped.code = err.code;
        reject(wrapped);
      });

      req.setTimeout(30000, () => {
        req.destroy();
        const e = new Error('Timeout na requisição SEFIN (30s)');
        e.code = 'ETIMEDOUT';
        reject(e);
      });

      if (body) {
        req.write(typeof body === 'string' ? body : body);
      }
      req.end();
    });
  }

  /**
   * Consulta se uma DPS já gerou NFS-e (GET /dps/{idDps}).
   *
   * É a guarda de idempotência que torna seguro reenviar um POST de emissão:
   * 200 devolve a chaveAcesso da nota gerada, 404/E2404 confirma que a DPS
   * não foi processada.
   *
   * @param {string} idDps - Id da DPS (com ou sem prefixo "DPS")
   * @returns {Promise<string|null>} chaveAcesso, ou null se não gerou nota
   */
  async chaveDaDps(idDps) {
    const url = `${this.baseUrl}/dps/${idDps}`;
    const response = await this._requestWithRetry('GET', url);

    if (response.status >= 400) return null;

    try {
      const data = typeof response.data === 'string' ? JSON.parse(response.data) : response.data;
      return data?.chaveAcesso || null;
    } catch {
      return null;
    }
  }

  /**
   * Emitir NFS-e: GZip o XML assinado, codifica em Base64, envia POST /nfse
   *
   * Retry: o balanceador da SEFIN devolve 503 com HTML do IIS de forma
   * intermitente (~1 em 5 POSTs, medido em 2026-08-11), antes da requisição
   * chegar na aplicação — a DPS nem é processada. Esses casos são
   * reenviados, mas só depois de `chaveDaDps` confirmar que a DPS não virou
   * nota; sem idDps, ou se a consulta falhar, não há reenvio (o risco de
   * dupla emissão fiscal continua valendo mais que a retentativa).
   * Erro devolvido pela aplicação (JSON, ex. E1226) nunca faz retry.
   *
   * @param {string} signedXml - XML da DPS assinado
   * @param {string} [idDps] - Id da DPS, habilita o retry seguro
   * @returns {Promise<Object>} Resposta da SEFIN
   */
  async emitirNfse(signedXml, idDps = null) {
    // GZip + Base64
    const xmlBuffer = Buffer.from(signedXml, 'utf-8');
    const gzipped = zlib.gzipSync(xmlBuffer);
    const dpsXmlGZipB64 = gzipped.toString('base64');

    const payload = JSON.stringify({ dpsXmlGZipB64 });
    const url = `${this.baseUrl}/nfse`;

    console.log(`[NFSe] Emitindo NFS-e em ${this.tpAmb === 1 ? 'PRODUÇÃO' : 'HOMOLOGAÇÃO'}`);
    console.log(`[NFSe] URL: ${url}`);

    const maxTries = 3;
    const baseDelays = [0, 1500, 4000];
    let ultimaFalha = null;

    for (let attempt = 0; attempt < maxTries; attempt++) {
      if (attempt > 0) {
        if (!idDps) break; // sem guarda de idempotência, não reenvia

        await _sleep(baseDelays[attempt] + Math.floor(Math.random() * 500));

        let chave;
        try {
          chave = await this.chaveDaDps(idDps);
        } catch (e) {
          console.warn(`[NFSe] Guarda de idempotência indisponível (${e.message}) — não reenviando`);
          break;
        }
        if (chave) {
          console.log(`[NFSe] DPS ${idDps} já virou NFS-e ${chave} — recuperando em vez de reenviar`);
          return this.consultarNfse(chave);
        }
        console.log(`[NFSe][retry] tentativa ${attempt + 1}/${maxTries} — DPS ${idDps} não processada`);
      }

      let response;
      try {
        response = await this._request('POST', url, payload);
      } catch (err) {
        if (_isTransientErr(err) && attempt < maxTries - 1) { ultimaFalha = err; continue; }
        throw err;
      }

      if (response.status < 400) return response.data;

      // Erro de infraestrutura: 502/503/504 servido como HTML pelo IIS, sem
      // passar pela aplicação. Erro da aplicação vem como JSON e é final.
      const contentType = String(response.headers['content-type'] || '');
      const infra = TRANSIENT_STATUS.has(response.status) && !contentType.includes('application/json');

      if (infra) {
        ultimaFalha = new Error(
          `SEFIN indisponível (HTTP ${response.status}) — a nota NÃO foi emitida. ` +
          `Instabilidade momentânea do balanceador; tente novamente.`
        );
        if (attempt < maxTries - 1) continue;
        break;
      }

      const errorMsg = typeof response.data === 'object'
        ? JSON.stringify(response.data)
        : response.data;
      throw new Error(`SEFIN retornou ${response.status}: ${errorMsg}`);
    }

    throw ultimaFalha || new Error('SEFIN: emissão falhou sem causa registrada');
  }

  /**
   * Consultar NFS-e por chave de acesso
   * @param {string} chaveAcesso - Chave de acesso da NFS-e
   * @returns {Promise<Object>}
   */
  async consultarNfse(chaveAcesso) {
    const url = `${this.baseUrl}/nfse/${chaveAcesso}`;
    console.log(`[NFSe] Consultando NFS-e: ${chaveAcesso}`);

    // NFSE-H09: GET idempotente — usa retry com backoff
    const response = await this._requestWithRetry('GET', url);

    if (response.status >= 400) {
      throw new Error(`Erro ao consultar NFS-e: ${response.status}`);
    }

    return response.data;
  }

  /**
   * Download da DANFSE (PDF)
   * @param {string} chaveAcesso - Chave de acesso da NFS-e
   * @returns {Promise<Buffer>} PDF como Buffer
   */
  async downloadDanfse(chaveAcesso) {
    const url = `${this.baseUrl}/danfse/${chaveAcesso}`;
    console.log(`[NFSe] Baixando DANFSE: ${chaveAcesso}`);

    // NFSE-H09: GETs idempotentes usam retry com backoff
    const response = await this._requestWithRetry('GET', url, null, {
      'Accept': 'application/pdf',
    });

    if (response.status < 400) {
      return response.data; // Buffer do PDF oficial
    }

    // Fallback: gerar PDF a partir do XML da NFSe
    console.log(`[NFSe] DANFSE indisponivel (${response.status}), gerando PDF do XML...`);
    const xmlUrl = `${this.baseUrl}/nfse/${chaveAcesso}`;
    const xmlResp = await this._requestWithRetry('GET', xmlUrl, null, { 'Accept': 'application/json' });

    if (xmlResp.status >= 400) {
      throw new Error(`Erro ao consultar NFSe para gerar DANFSE: ${xmlResp.status}`);
    }

    const data = typeof xmlResp.data === 'string' ? JSON.parse(xmlResp.data) : xmlResp.data;
    if (!data.nfseXmlGZipB64) {
      throw new Error('XML da NFSe nao disponivel para gerar DANFSE');
    }

    const { gerarDanfseDeGzipB64 } = require('./danfse-pdf');
    return gerarDanfseDeGzipB64(data.nfseXmlGZipB64);
  }

  /**
   * Cancelar NFS-e — envia evento (tpEvento=101101) já assinado.
   *
   * @param {string} chaveAcesso - Chave de acesso (50 dígitos)
   * @param {string} signedEventoXml - XML do evento já assinado (XMLDSIG)
   * @returns {Promise<Object>}
   */
  async cancelarNfse(chaveAcesso, signedEventoXml) {
    const url = `${this.baseUrl}/nfse/${chaveAcesso}/eventos`;
    console.log(`[NFSe] Cancelando NFS-e: ${chaveAcesso}`);

    const xmlBuffer = Buffer.from(signedEventoXml, 'utf-8');
    const gzipped = zlib.gzipSync(xmlBuffer);
    const pedidoRegistroEventoXmlGZipB64 = gzipped.toString('base64');

    // Nome do campo espelha o root XML <pedRegEvento>, análogo a
    // dpsXmlGZipB64 espelhar <DPS> na emissão. Confirmado em backup
    // pré-refactor (nfse-client.js.bak-20260420-062459).
    const payload = JSON.stringify({ pedidoRegistroEventoXmlGZipB64 });
    const response = await this._request('POST', url, payload);

    if (response.status >= 400) {
      const errorMsg = typeof response.data === 'object'
        ? JSON.stringify(response.data)
        : response.data;
      throw new Error(`Erro ao cancelar NFS-e: ${response.status} - ${errorMsg}`);
    }

    return response.data;
  }

  /**
   * Consultar parâmetros municipais (endpoint de diagnóstico).
   *
   * Nota: na prática esse endpoint retorna 404 HTML genérico para QUALQUER
   * código IBGE testado (incluindo cidades que emitem com sucesso). Não
   * é confiável como teste de habilitação — use a estratégia de aprender
   * com o feedback real da emissão (E0039 cacheado em nfse_config).
   * Mantido como diagnóstico no modal de config.
   */
  async parametrosMunicipais(codMunicipio) {
    const url = `${this.baseUrl}/parametros_municipais/${codMunicipio}/convenio`;
    console.log(`[NFSe] Consultando parâmetros municipais: ${codMunicipio}`);

    // NFSE-H09: GET idempotente — usa retry com backoff
    const response = await this._requestWithRetry('GET', url);

    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      data: response.data,
    };
  }
}

module.exports = { NfseClient };
