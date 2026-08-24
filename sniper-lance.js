/**
 * sniper-lance.js — Sistema de lance sniper para Comprasnet
 *
 * Envia lances via chamadas HTTP diretas usando Bearer token.
 * O token é recebido do Electron Standalone (electron-standalone/).
 * NÃO depende de Puppeteer, CDP ou túnel SSH.
 * 
 * API Comprasnet:
 *   POST /comprasnet-disputa/v1/compras/{compraId}/itens/{itemNumero}/lances
 *   Body: { valorInformado: number, faseItem: "LA" }
 *   Headers: Authorization: Bearer ..., x-device-platform: web, x-version-number: 5.5.2
 */

const axios = require('axios');
const https = require('https');

// Pool de sockets TLS reutilizáveis contra Comprasnet.
// Sem isso, cada request faz handshake novo (~100ms); com keepAlive cai pra ~50ms.
// Essencial pro Guard poll a >5Hz e pra rajada (múltiplos POSTs em <1s).
const keepAliveAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 20,
  maxFreeSockets: 10,
  timeout: 60000,
});

const BASE_URL = 'https://cnetmobile.estaleiro.serpro.gov.br';
const TOKEN_MAX_AGE_S = 600; // 10 minutos — tokens Comprasnet expiram por volta disso
const TOKEN_SAFE_MARGIN_S = TOKEN_MAX_AGE_S - 60; // 540s — margem de segurança usada por callers (electron/processor) para pedir renovação antes da expiração real

/**
 * Constrói compraId canônico no formato UASG(6) + MODALIDADE(2) + NUMERO(5) + ANO(4).
 * Aceita objetos no formato Comprasnet (numeroUasg/codigoModalidade/numero/ano ou
 * identificadores alternativos). Retorna null se não conseguir construir.
 *
 * ⚠️ Crítico: esta ordem precisa ser idêntica em TODOS os callers (extensão, Electron,
 * servidor) — se divergir, gera participações duplicadas em participacoes_comprasnet.
 */
function buildCompraId(compra) {
  if (!compra) return null;
  if (compra.compraId && typeof compra.compraId === 'string' && compra.compraId.length >= 15) {
    return compra.compraId;
  }
  const uasg = String(compra.numeroUasg || compra.uasg || '').replace(/\D/g, '').padStart(6, '0');
  const mod  = String(compra.codigoModalidade || compra.modalidade || '').replace(/\D/g, '').padStart(2, '0');
  const num  = String(compra.numero || compra.numeroCompra || compra.sequencial || '').replace(/\D/g, '').padStart(5, '0');
  const ano  = String(compra.ano || compra.anoCompra || '').replace(/\D/g, '');
  if (!uasg || uasg === '000000' || !ano || ano.length < 4) return null;
  return uasg + mod + num + ano;
}

const API_HEADERS = {
  'Accept': 'application/json, text/plain, */*',
  'Content-Type': 'application/json',
  'x-device-platform': 'web',
  'x-version-number': '6.0.2',
  'Cache-Control': 'no-cache, no-store, max-age=0, must-revalidate',
};

class SniperLance {
  constructor() {
    this.bearerToken = null;          // "Bearer eyJ..."
    this.tokenRecebidoEm = null;      // timestamp
    this.tokenSource = null;           // 'extension' | 'manual' | 'monitor'
    this.captchaToken = null;          // "P1_eyJ..." — hCaptcha token
    this.captchaRecebidoEm = null;     // timestamp

    this.agendamentos = new Map();     // id -> { timer, config }
    this.historico = [];               // últimos 50 lances
    this.logs = [];
    this.maxLogs = 500;

    // Phase B/C (2026-04-23): state de closure global migrado para instance
    // fields para isolar por-tenant. Antes vazava entre tenants.
    this.disputasCache = { disputas: [], atualizadoEm: null };
    this.filaLances = [];
    this.resultadosLances = [];
    this.filaTarefas = [];
    this.tarefaIdCounter = 0;
    this.autoLanceAtivo = false;
    this.autoLanceTimerNormal = null;
    this.autoLanceTimerRapido = null;
    this.autoLanceTimerUltra = null;
    this.autoLancePendentes = {};
    this.autoLanceComprasFast = {};
    this.autoLanceLog = [];
    this.autoLanceStats = { ciclos: 0, lancesEnviados: 0, ultimoCiclo: null };
    this.blitzDisparados = {};
    this.guardLoops = {};
    this.guardStats = { totalPolls: 0, detections: 0, lancesEnqueued: 0 };

    // Cache de validação de token
    this._lastValidatedToken = null;
    this._lastValidatedAt = null;

    // Offset de tempo servidor vs local
    this.offsetServidorMs = 0;
    this.ultimaCalibracao = null;
  }

  log(msg) {
    const ts = new Date().toLocaleTimeString('pt-BR', { hour12: false });
    const entry = `[${ts}] ${msg}`;
    this.logs.push(entry);
    if (this.logs.length > this.maxLogs) this.logs.shift();
    console.log(`[Sniper] ${entry}`);
  }

  // ==================== TOKEN ====================

  /**
   * Recebe e armazena o Bearer token (da extensão, manual, ou monitor).
   * @param {string} token - "Bearer eyJ..." ou apenas "eyJ..."
   * @param {string} source - origem do token
   */
  initDb(db) {
    this.db = db;
    try {
      const row = db.prepare("SELECT valor FROM config WHERE chave = 'bearer_token'").get();
      const src = db.prepare("SELECT valor FROM config WHERE chave = 'bearer_source'").get();
      const ts  = db.prepare("SELECT valor FROM config WHERE chave = 'bearer_timestamp'").get();
      if (row && row.valor && ts && ts.valor) {
        const idade = (Date.now() - new Date(ts.valor).getTime()) / 1000;
        if (idade < TOKEN_SAFE_MARGIN_S) {
          this.bearerToken = row.valor;
          this.tokenRecebidoEm = ts.valor;
          this.tokenSource = src ? src.valor : 'db';
          this.log('Bearer restaurado do banco (' + Math.floor(idade) + 's, fonte: ' + this.tokenSource + ')');
        } else {
          this.log('Bearer no banco expirado (' + Math.floor(idade) + 's) - aguardando novo envio');
        }
      }
    } catch (e) {
      this.log('Erro ao carregar bearer do banco: ' + e.message);
    }
  }

  _persistirToken() {
    if (!this.db || !this.bearerToken) return;
    try {
      const ts = this.tokenRecebidoEm || new Date().toISOString();
      this.db.prepare("INSERT OR REPLACE INTO config (chave, valor) VALUES ('bearer_token', ?)").run(this.bearerToken);
      this.db.prepare("INSERT OR REPLACE INTO config (chave, valor) VALUES ('bearer_source', ?)").run(this.tokenSource || 'unknown');
      this.db.prepare("INSERT OR REPLACE INTO config (chave, valor) VALUES ('bearer_timestamp', ?)").run(ts);
    } catch (e) {
      this.log('Erro ao persistir bearer: ' + e.message);
    }
  }

  setToken(token, source = 'manual') {
    if (!token) return;
    const newToken = token.startsWith('Bearer ') ? token : `Bearer ${token}`;

    // Prioridade: electron > extension > manual
    // Se já tem token fresco, só aceitar de fonte igual ou superior
    if (this.bearerToken && this.tokenRecebidoEm) {
      const idade = this.idadeTokenSegundos();
      const prioridade = { electron: 3, puppeteer: 2, extension: 1, manual: 0, api: 0 };
      const prioAtual = prioridade[this.tokenSource] || 0;
      const prioNovo = prioridade[source] || 0;

      // Token atual ainda válido e fonte nova tem prioridade menor → rejeitar
      if (idade < TOKEN_SAFE_MARGIN_S && prioNovo < prioAtual) {
        return; // Silencioso — não poluir log
      }

      // Mesmo token → só atualizar timestamp se mudou
      if (newToken === this.bearerToken && prioNovo <= prioAtual) {
        this._persistirToken();
        this.tokenRecebidoEm = new Date().toISOString();
        return;
      }
    }

    const tokenAntigo = this.bearerToken;
    this.bearerToken = newToken;
    this.tokenRecebidoEm = new Date().toISOString();
    this.tokenSource = source;
    this._tokenMortoAlertado = false; // novo token chegou → libera próximo alerta de morte
    this.log(`🔑 Bearer recebido (${source}): ${this.bearerToken.substring(0, 30)}...`);
    this._persistirToken();
    // Registrar no histórico com expiração real do JWT
    this._registrarNoHistorico(newToken, source, tokenAntigo);
  }

  // Decodifica claims do JWT (payload) sem validar assinatura. Retorna null se inválido.
  _decodeJwtPayload(bearerToken) {
    try {
      const raw = bearerToken.replace(/^Bearer\s+/, '');
      const parts = raw.split('.');
      if (parts.length !== 3) return null;
      const padded = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      const padLen = padded.length % 4 === 0 ? 0 : (4 - padded.length % 4);
      const fixed = padded + '='.repeat(padLen);
      const json = Buffer.from(fixed, 'base64').toString('utf8');
      return JSON.parse(json);
    } catch (_) { return null; }
  }

  _fingerprint(bearerToken) {
    try {
      const raw = bearerToken.replace(/^Bearer\s+/, '');
      const crypto = require('crypto');
      return crypto.createHash('sha1').update(raw.substring(0, 40)).digest('hex').substring(0, 12);
    } catch (_) { return null; }
  }

  _registrarNoHistorico(newToken, source, tokenAntigo) {
    if (!this.db) return;
    try {
      const payload = this._decodeJwtPayload(newToken) || {};
      const fp = this._fingerprint(newToken);
      const expEm = payload.exp ? new Date(payload.exp * 1000).toISOString() : null;
      const subject = payload.sub || payload.preferred_username || null;
      const jti = payload.jti || null;
      const duracaoEsperada = payload.exp && payload.iat ? (payload.exp - payload.iat) : null;
      const agora = new Date().toISOString();
      // Marca o anterior como substituído
      if (tokenAntigo) {
        const fpAnt = this._fingerprint(tokenAntigo);
        this.db.prepare(`UPDATE bearer_history SET substituidoEm = ? WHERE tokenFingerprint = ? AND substituidoEm IS NULL`).run(agora, fpAnt);
      }
      this.db.prepare(`INSERT OR IGNORE INTO bearer_history
        (source, tokenFingerprint, jti, subject, recebidoEm, expEm, duracaoEsperadaSeg)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(source, fp, jti, subject, agora, expEm, duracaoEsperada);
    } catch (e) {
      this.log('Erro ao registrar token no histórico: ' + e.message);
    }
  }

  // Retorna timestamp de expiração real (do JWT) ou null se não conseguir decodificar
  expiraEm() {
    if (!this.bearerToken) return null;
    const payload = this._decodeJwtPayload(this.bearerToken);
    return payload?.exp ? new Date(payload.exp * 1000) : null;
  }

  // Segundos até expirar (negativo = já expirou). null se não decodificou.
  segundosAteExpirar() {
    const exp = this.expiraEm();
    return exp ? Math.floor((exp.getTime() - Date.now()) / 1000) : null;
  }

  /**
   * Recebe e armazena o hCaptcha token.
   */
  setCaptchaToken(captchaToken) {
    if (!captchaToken) return;
    this.captchaToken = captchaToken;
    this.captchaRecebidoEm = new Date().toISOString();
    this.log(`🛡️ Captcha recebido: ${captchaToken.substring(0, 20)}...`);
  }

  /**
   * Valida um token contra o endpoint datahorabrasilia do Comprasnet.
   * @param {string} token - "Bearer eyJ..."
   * @returns {{ valid: boolean, status: number|null, cached: boolean }}
   */
  async validateToken(token) {
    // Cache: se mesmo token validado nos últimos 60s, pular
    if (this._lastValidatedToken === token && this._lastValidatedAt) {
      const age = Date.now() - this._lastValidatedAt;
      if (age < 60000) {
        return { valid: true, status: 200, cached: true };
      }
    }

    try {
      const url = `${BASE_URL}/comprasnet-disputa/v1/datahorabrasilia`;
      const resp = await axios.get(url, {
        headers: { ...API_HEADERS, Authorization: token },
        timeout: 8000,
        validateStatus: () => true,
        httpsAgent: keepAliveAgent,
      });

      const valid = resp.status === 200;
      if (valid) {
        this._lastValidatedToken = token;
        this._lastValidatedAt = Date.now();
      }

      this.log(`🔍 Validação token: HTTP ${resp.status} → ${valid ? 'VÁLIDO' : 'INVÁLIDO'}`);
      return { valid, status: resp.status, cached: false };
    } catch (e) {
      // Timeout/erro de rede → aceitar otimisticamente
      this.log(`⚠️ Validação token: erro rede (${e.message}) → aceito otimisticamente`);
      return { valid: true, status: null, cached: false };
    }
  }

  /**
   * Força expiração do token (marca como recebido há 10 min).
   */
  forceExpireToken() {
    if (this.tokenRecebidoEm) {
      this.tokenRecebidoEm = new Date(Date.now() - TOKEN_MAX_AGE_S * 1000).toISOString();
      this.log('⏰ Token marcado como expirado (health check falhou)');
    }
  }

  getToken() {
    if (!this.bearerToken) {
      throw new Error('Sem Bearer token. Abra o Comprasnet pelo Electron LiciteAgora.');
    }
    return this.bearerToken;
  }

  getCaptchaToken() {
    if (!this.captchaToken) {
      throw new Error('Sem captcha token. Navegue no Comprasnet para gerar um.');
    }
    return this.captchaToken;
  }

  temToken() {
    return !!this.bearerToken;
  }

  temCaptcha() {
    return !!this.captchaToken;
  }

  idadeTokenSegundos() {
    if (!this.tokenRecebidoEm) return Infinity;
    return (Date.now() - new Date(this.tokenRecebidoEm).getTime()) / 1000;
  }

  idadeCaptchaSegundos() {
    if (!this.captchaRecebidoEm) return Infinity;
    return (Date.now() - new Date(this.captchaRecebidoEm).getTime()) / 1000;
  }

  tokenExpirado() {
    return this.idadeTokenSegundos() > TOKEN_MAX_AGE_S;
  }

  // ==================== HTTP HELPERS ====================

  /**
   * GET autenticada (só Bearer, sem captcha).
   */
  async apiGet(path) {
    const token = this.getToken();
    const url = `${BASE_URL}${path}`;
    const resp = await axios.get(url, {
      headers: { ...API_HEADERS, Authorization: token },
      timeout: 10000,
      validateStatus: () => true,
      httpsAgent: keepAliveAgent,
    });
    return { status: resp.status, data: resp.data };
  }

  /**
   * GET autenticada COM captcha token (para /mensagem/ e /fase-externa/).
   * Adiciona ?captcha=TOKEN ou &captcha=TOKEN à URL.
   */
  async apiGetCaptcha(path) {
    const token = this.getToken();
    const captcha = this.getCaptchaToken();
    const sep = path.includes('?') ? '&' : '?';
    const url = `${BASE_URL}${path}${sep}captcha=${captcha}`;
    const resp = await axios.get(url, {
      headers: { ...API_HEADERS, Authorization: token },
      timeout: 15000,
      validateStatus: () => true,
      httpsAgent: keepAliveAgent,
    });
    return { status: resp.status, data: resp.data };
  }

  /**
   * POST autenticada (só Bearer).
   */
  async apiPost(path, body) {
    const token = this.getToken();
    const url = `${BASE_URL}${path}`;
    const resp = await axios.post(url, body, {
      headers: { ...API_HEADERS, Authorization: token },
      timeout: 10000,
      validateStatus: () => true,
      httpsAgent: keepAliveAgent,
    });
    return { status: resp.status, data: resp.data };
  }

  async apiPut(path, body) {
    const token = this.getToken();
    const url = `${BASE_URL}${path}`;
    const resp = await axios.put(url, body, {
      headers: { ...API_HEADERS, Authorization: token },
      timeout: 10000,
      validateStatus: () => true,
      httpsAgent: keepAliveAgent,
    });
    return { status: resp.status, data: resp.data };
  }

  async apiDelete(path) {
    const token = this.getToken();
    const url = `${BASE_URL}${path}`;
    const resp = await axios.delete(url, {
      headers: { ...API_HEADERS, Authorization: token },
      timeout: 10000,
      validateStatus: () => true,
      httpsAgent: keepAliveAgent,
    });
    return { status: resp.status, data: resp.data };
  }

  // ==================== CALIBRAÇÃO DE TEMPO ====================

  /**
   * Calibra o offset entre o relógio local e o do servidor Comprasnet.
   */
  async calibrarTempo() {
    try {
      const endpoint = '/comprasnet-disputa/v1/datahorabrasilia';

      const parseResposta = (data) => {
        const raw = typeof data === 'string' ? data.replace(/"/g, '').trim() : String(data);
        if (/^\d{13}$/.test(raw)) return parseInt(raw);
        if (/^\d{10}$/.test(raw)) return parseInt(raw) * 1000;
        const ts = new Date(raw).getTime();
        if (isNaN(ts)) throw new Error(`Formato não reconhecido: ${raw}`);
        return ts;
      };

      // 1. Warmup — descarta (aquece TLS/conexão)
      await this.apiGet(endpoint);

      // 2. Fazer 5 medições reais
      const amostras = [];
      for (let i = 0; i < 5; i++) {
        const antes = Date.now();
        const { status, data } = await this.apiGet(endpoint);
        const depois = Date.now();
        if (status !== 200) continue;
        const latencia = depois - antes;
        const tempoServidor = parseResposta(data);
        const tempoLocal = antes + Math.floor(latencia / 2);
        const offset = tempoServidor - tempoLocal;
        amostras.push({ offset, latencia });
      }

      if (amostras.length < 3) throw new Error('Menos de 3 amostras válidas');

      // 3. Ordenar por latência, descartar maior e menor (outliers)
      amostras.sort((a, b) => a.latencia - b.latencia);
      const filtradas = amostras.slice(1, -1); // remove menor e maior latência

      // 4. Mediana do offset
      const offsets = filtradas.map(a => a.offset).sort((a, b) => a - b);
      const mediana = offsets[Math.floor(offsets.length / 2)];
      const latenciaMedia = Math.round(filtradas.reduce((s, a) => s + a.latencia, 0) / filtradas.length);

      this.offsetServidorMs = mediana;
      this.ultimaCalibracao = new Date().toISOString();

      this.log(`🕐 Calibração: offset=${mediana}ms (amostras: ${amostras.map(a => a.offset + 'ms').join(', ')}), latência média=${latenciaMedia}ms`);
      return { offset: mediana, latencia: latenciaMedia, tempoServidor: new Date(Date.now() + mediana).toISOString() };
    } catch (e) {
      this.log(`⚠️ Erro calibração: ${e.message}`);
      throw e;
    }
  }

  tempoServidorAgora() {
    return Date.now() + this.offsetServidorMs;
  }

  // ==================== ENVIO DE LANCE ====================

  /**
   * Envia um lance imediatamente via API HTTP direta.
   * Plano 16: Gate global 'sniper_motor_enabled' — se desligado, o lance
   * NÃO vai para o Comprasnet. Todos os caminhos (manual ⚡, agendado,
   * rajada individual e Rajada Global) passam por aqui, então o gate
   * pega todos. Cache 5s pra não bater no DB em cada lance de um lote.
   */
  _motorLigado() {
    const agora = Date.now();
    if (!this._motorCache || agora > this._motorCache.expira) {
      let ligado = true;
      try {
        const row = this.db && this.db.prepare("SELECT valor FROM config WHERE chave='sniper_motor_enabled'").get();
        ligado = row ? row.valor !== '0' : true; // default on
      } catch (_) { ligado = true; }
      this._motorCache = { valor: ligado, expira: agora + 5000 };
    }
    return this._motorCache.valor;
  }
  invalidarMotorCache() { this._motorCache = null; }

  async enviarLance(compraId, itemNumero, valor, faseItem = 'LA') {
    if (!this._motorLigado()) {
      return {
        sucesso: false,
        status: 0,
        tempoMs: 0,
        resposta: '[motor de lances desligado — lance não enviado]',
        bloqueado: true,
      };
    }
    const inicio = Date.now();

    const { status, data } = await this.apiPost(
      `/comprasnet-disputa/v1/compras/${compraId}/itens/${itemNumero}/lances`,
      { valorInformado: valor, faseItem }
    );

    const tempoMs = Date.now() - inicio;
    const resposta = typeof data === 'string' ? data : JSON.stringify(data);

    const lance = {
      compraId,
      itemNumero,
      valor,
      faseItem,
      status,
      resposta,
      tempoMs,
      timestamp: new Date().toISOString(),
      sucesso: status === 200 || status === 201,
    };

    this.historico.unshift(lance);
    if (this.historico.length > 50) this.historico.pop();

    if (lance.sucesso) {
      this.log(`🎯 LANCE ENVIADO! R$ ${valor.toFixed(2)} item ${itemNumero} (${tempoMs}ms)`);
    } else {
      this.log(`❌ Lance falhou: HTTP ${status} - ${resposta.substring(0, 100)} (${tempoMs}ms)`);
    }

    return lance;
  }

  // ==================== AGENDAMENTO SNIPER ====================

  agendar(config) {
    const {
      id,
      compraId,
      itemNumero,
      valor,
      faseItem = 'LA',
      horarioAlvo,
      antecedenciaMs = 500,
      tentativas = 3,
      intervaloTentativasMs = 200,
    } = config;

    if (this.agendamentos.has(id)) {
      this.cancelar(id);
    }

    const alvoMs = new Date(horarioAlvo).getTime();
    const disparoMs = alvoMs - antecedenciaMs;
    const agoraMs = Date.now();
    const delayMs = disparoMs - agoraMs;

    if (delayMs < 0) {
      this.log(`⚠️ Horário alvo já passou! (${Math.abs(delayMs)}ms atrás)`);
      return { success: false, error: 'Horário alvo já passou' };
    }

    this.log(`⏱️ Lance agendado: R$ ${valor.toFixed(2)} | item ${itemNumero} | ${horarioAlvo}`);
    this.log(`   Disparo em ${(delayMs / 1000).toFixed(1)}s (${antecedenciaMs}ms antes do alvo)`);
    this.log(`   ${tentativas} tentativa(s) com ${intervaloTentativasMs}ms entre cada`);

    const timer = setTimeout(async () => {
      this.log(`🚀 SNIPER DISPARANDO! Alvo: ${horarioAlvo}`);

      if (!this.temToken()) {
        this.log(`❌ ABORTANDO — sem Bearer token no momento do disparo!`);
        const agendamento = this.agendamentos.get(id);
        if (agendamento) {
          agendamento.resultados = [{ sucesso: false, error: 'Sem Bearer token' }];
          agendamento.executado = true;
          agendamento.executadoEm = new Date().toISOString();
        }
        return;
      }

      const resultados = [];

      // Status codes: 400 = payload inválido; 401 = token morto; 422 = regra de negócio.
      // Nenhum deles se resolve com retry — retentar desperdiça janela crítica da blitz.
      const FATAL_STATUSES = new Set([400, 401, 403, 422]);

      for (let t = 0; t < tentativas; t++) {
        let ultimoStatus = null;
        try {
          const resultado = await this.enviarLance(compraId, itemNumero, valor, faseItem);
          resultados.push(resultado);
          ultimoStatus = resultado.status;

          if (resultado.sucesso) {
            this.log(`✅ Tentativa ${t + 1}/${tentativas}: SUCESSO em ${resultado.tempoMs}ms`);
            break;
          } else {
            this.log(`⚠️ Tentativa ${t + 1}/${tentativas}: falhou (${resultado.status})`);
            if (FATAL_STATUSES.has(resultado.status)) {
              this.log(`🛑 Status ${resultado.status} é fatal — abortando retries`);
              break;
            }
          }
        } catch (e) {
          this.log(`❌ Tentativa ${t + 1}/${tentativas}: erro - ${e.message}`);
          resultados.push({ sucesso: false, error: e.message });
        }

        if (t < tentativas - 1) {
          await new Promise(r => setTimeout(r, intervaloTentativasMs));
        }
      }

      const agendamento = this.agendamentos.get(id);
      if (agendamento) {
        agendamento.resultados = resultados;
        agendamento.executado = true;
        agendamento.executadoEm = new Date().toISOString();
      }
    }, delayMs);

    this.agendamentos.set(id, {
      config,
      timer,
      criadoEm: new Date().toISOString(),
      disparoEm: new Date(disparoMs).toISOString(),
      alvoEm: horarioAlvo,
      executado: false,
      resultados: null,
    });

    return {
      success: true,
      id,
      disparoEm: new Date(disparoMs).toISOString(),
      delaySegundos: (delayMs / 1000).toFixed(1),
    };
  }

  cancelar(id) {
    const agendamento = this.agendamentos.get(id);
    if (agendamento && agendamento.timer) {
      clearTimeout(agendamento.timer);
      this.agendamentos.delete(id);
      this.log(`🛑 Agendamento ${id} cancelado`);
      return true;
    }
    return false;
  }

  listarAgendamentos() {
    const lista = [];
    for (const [id, ag] of this.agendamentos) {
      lista.push({
        id,
        compraId: ag.config.compraId,
        item: ag.config.itemNumero,
        valor: ag.config.valor,
        alvo: ag.alvoEm,
        disparo: ag.disparoEm,
        executado: ag.executado,
        resultados: ag.resultados,
      });
    }
    return lista;
  }

  // ==================== CONSULTA DE DISPUTA ====================

  /**
   * Consulta os itens em seleção/disputa de uma compra específica.
   * Tenta com captcha primeiro (fase-externa), depois sem (disputa).
   */
  async consultarItens(compraId) {
    this.log(`🔍 Consultando itens da disputa ${compraId}...`);

    const tentativas = [];

    // 1. Tentar disputa API PRIMEIRO (não precisa captcha, mais provável funcionar do servidor)
    const endpointsDisputa = [
      `/comprasnet-disputa/v1/compras/${compraId}/itens/em-disputa`,
      `/comprasnet-disputa/v1/compras/${compraId}/itens`,
      `/comprasnet-disputa/v1/compras/${compraId}/itens/classificacao`,
    ];

    for (const path of endpointsDisputa) {
      try {
        const { status, data } = await this.apiGet(path);
        tentativas.push({ path: path.substring(path.lastIndexOf('/v1/')), status });
        if (status === 200 || status === 206) {
          const itens = Array.isArray(data) ? data : [data];
          this.log(`✅ ${itens.length} itens (disputa) — ${path.split('/v1/')[1]}`);
          return { success: true, itens, endpoint: 'disputa' };
        }
        this.log(`⚠️ disputa ${status}: ${path.split('/v1/')[1]}`);
      } catch (e) {
        tentativas.push({ path: path.substring(path.lastIndexOf('/v1/')), error: e.message });
        this.log(`⚠️ disputa erro: ${e.message}`);
      }
    }

    // 2. Tentar fase-externa com captcha (IP-bound, pode falhar do servidor)
    if (this.temCaptcha()) {
      const pathFE = `/comprasnet-fase-externa/v1/compras/${compraId}/itens/em-selecao-fornecedores`;
      try {
        const { status, data } = await this.apiGetCaptcha(pathFE);
        tentativas.push({ path: 'fase-externa+captcha', status });
        if (status === 200 || status === 206) {
          const itens = Array.isArray(data) ? data : [data];
          this.log(`✅ ${itens.length} itens (fase-externa+captcha)`);
          return { success: true, itens, endpoint: 'fase-externa' };
        }
        this.log(`⚠️ fase-externa+captcha ${status}`);
      } catch (e) {
        tentativas.push({ path: 'fase-externa+captcha', error: e.message });
        this.log(`⚠️ fase-externa+captcha erro: ${e.message}`);
      }
    }

    // 3. Tentar fase-externa sem captcha (último recurso)
    const pathFE2 = `/comprasnet-fase-externa/v1/compras/${compraId}/itens/em-selecao-fornecedores`;
    try {
      const { status, data } = await this.apiGet(pathFE2);
      tentativas.push({ path: 'fase-externa-sem-captcha', status });
      if (status === 200 || status === 206) {
        const itens = Array.isArray(data) ? data : [data];
        this.log(`✅ ${itens.length} itens (fase-externa sem captcha)`);
        return { success: true, itens, endpoint: 'fase-externa' };
      }
      this.log(`⚠️ fase-externa sem captcha ${status}`);
    } catch (e) {
      tentativas.push({ path: 'fase-externa-sem-captcha', error: e.message });
    }

    const resumo = tentativas.map(t => `${t.path}→${t.status || t.error}`).join(', ');
    this.log(`❌ Nenhum endpoint retornou itens para ${compraId}: ${resumo}`);
    throw new Error(`Nenhum endpoint retornou dados: ${resumo}`);
  }

  /**
   * Busca disputas ativas entre as participações do banco.
   */
  async buscarDisputasAtivas(db) {
    const participacoes = db.prepare(
      `SELECT compraId, cnpj, ano, sequencial, orgao, objeto, etapa, situacao, faseCompra, dataSessao
       FROM participacoes_comprasnet WHERE ativo = 1 ORDER BY dataAtualizacao DESC`
    ).all();

    this.log(`🔎 Verificando ${participacoes.length} participações...`);
    const disputasAtivas = [];

    for (const p of participacoes) {
      try {
        const result = await this.consultarItens(p.compraId);
        if (result.success && result.itens?.length > 0) {
          const itensAtivos = result.itens.filter(item => {
            const fase = item.fase || '';
            return fase === 'LA' || fase === 'D1' || fase === 'D2' || item.podeEnviarLances;
          });

          if (itensAtivos.length > 0) {
            disputasAtivas.push({
              compraId: p.compraId,
              orgao: p.orgao,
              objeto: p.objeto,
              dataSessao: p.dataSessao,
              totalItens: result.itens.length,
              itensAtivos: itensAtivos.length,
              itens: itensAtivos.map(i => ({
                numero: i.numero || i.identificador,
                descricao: (i.descricao || '').substring(0, 80),
                fase: i.fase,
                situacao: i.situacao,
                melhorValor: i.melhorValorGeral?.valorInformado || null,
                nossoValor: i.melhorValorFornecedor?.valorInformado || null,
                podeEnviar: i.podeEnviarLances || false,
                fimContagem: i.dataHoraFimContagem || null,
              })),
            });
          }
        }
      } catch (e) {
        // Silently skip
      }
    }

    this.log(`✅ ${disputasAtivas.length} disputas ativas encontradas`);
    return disputasAtivas;
  }

  // ==================== SYNC PARTICIPAÇÕES (HTTP direto) ====================

  /**
   * Sincroniza participações via API Comprasnet → banco local.
   * Requer Bearer + Captcha token.
   */
  async syncParticipacoes(db) {
    if (!this.temCaptcha()) {
      throw new Error('Sem captcha token. Navegue no Comprasnet para gerar um.');
    }

    this.log('📋 Sincronizando participações via HTTP...');
    let totalSync = 0;
    let pagina = 0;

    while (true) {
      const { status, data } = await this.apiGetCaptcha(
        `/comprasnet-fase-externa/v1/compras/participacoes?filtro=5&tamanhoPagina=50&pagina=${pagina}`
      );

      if (status !== 200 && status !== 206) {
        this.log(`⚠️ Participações página ${pagina}: HTTP ${status}`);
        break;
      }

      const items = Array.isArray(data) ? data : [];
      if (items.length === 0) break;

      for (const item of items) {
        const compra = item.compra || item;
        const compraId = buildCompraId(compra);
        if (!compraId) continue;

        const existe = db.prepare('SELECT id FROM participacoes_comprasnet WHERE compraId = ?').get(compraId);

        if (existe) {
          db.prepare(`UPDATE participacoes_comprasnet SET
            situacao = COALESCE(?, situacao),
            faseCompra = COALESCE(?, faseCompra),
            objeto = COALESCE(?, objeto),
            dataAtualizacao = CURRENT_TIMESTAMP
            WHERE compraId = ?`).run(
            compra.situacaoCompraFaseExterna || compra.situacao || null,
            compra.faseCompraFaseExterna || compra.faseCompra || null,
            compra.objetoCompra || compra.objeto || null,
            compraId,
          );
        } else {
          db.prepare(`INSERT INTO participacoes_comprasnet
            (compraId, cnpj, ano, sequencial, orgao, objeto, situacao, faseCompra, ativo)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`).run(
            compraId,
            compra.numeroUasg || compra.cnpj || '',
            compra.ano || 0,
            compra.numero || compra.sequencial || 0,
            compra.nomeOrgao || compra.nomeUasg || compra.orgao || '',
            compra.objetoCompra || compra.objeto || '',
            compra.situacaoCompraFaseExterna || compra.situacao || '',
            compra.faseCompraFaseExterna || compra.faseCompra || '',
          );
        }
        totalSync++;
      }

      pagina++;
      if (items.length < 50) break;
    }

    this.log(`✅ ${totalSync} participações sincronizadas (${pagina} páginas)`);
    return { total: totalSync, paginas: pagina };
  }

  // ==================== STATUS ====================

  getStatus() {
    return {
      ativo: true,
      temToken: this.temToken(),
      tokenSource: this.tokenSource,
      tokenIdade: this.tokenRecebidoEm ? Math.floor(this.idadeTokenSegundos()) + 's' : null,
      tokenIdadeSegundos: this.tokenRecebidoEm ? Math.floor(this.idadeTokenSegundos()) : null,
      tokenRecebidoEm: this.tokenRecebidoEm,
      tokenExpirado: this.tokenExpirado(),
      needsToken: !this.temToken() || this.tokenExpirado(),
      temCaptcha: this.temCaptcha(),
      captchaIdade: this.captchaRecebidoEm ? Math.floor(this.idadeCaptchaSegundos()) + 's' : null,
      captchaRecebidoEm: this.captchaRecebidoEm,
      agendamentosAtivos: [...this.agendamentos.values()].filter(a => !a.executado).length,
      agendamentosTotal: this.agendamentos.size,
      ultimaCalibracao: this.ultimaCalibracao,
      offsetServidorMs: this.offsetServidorMs,
      tempoServidorEstimado: new Date(this.tempoServidorAgora()).toISOString(),
      lancesEnviados: this.historico.length,
    };
  }
}

// Classifica um 422 do Comprasnet pra decidir se vale continuar a rajada.
// Várias 422 são regra-de-negócio do lance INDIVIDUAL e não impedem os
// próximos degraus do batch — que são menores e costumam passar.
//
// 'intervalo-minimo' entrou em 2026-08-21 depois de uma blitz de 5 lances que
// enviou 1: o primeiro valor não guardava o intervalo mínimo em relação ao
// melhor valor do item, caía em 'outro' e abortava as 4 rodadas seguintes.
//
// Fatal de verdade só quando insistir não adianta:
//   fase-invalida  — item fechado, nenhum lance entra;
//   valor-baixo    — já bateu no piso do portal, e os próximos são MENORES.
function classificar422(resposta) {
  let msg = '';
  try {
    const parsed = typeof resposta === 'string' ? JSON.parse(resposta) : resposta;
    msg = (parsed && parsed.message ? String(parsed.message) : '').toLowerCase();
  } catch (_) {
    msg = String(resposta || '').toLowerCase();
  }
  if (/diferente.*registrado|j[áa] registrado.*outr|igual.*outr/.test(msg)) return 'colisao';
  // Antes de valor-baixo: "intervalo mínimo entre lances" fala de PASSO, não de
  // piso, e as duas mensagens compartilham a palavra "mínimo".
  if (/intervalo\s*m[íi]nimo|varia[çc][ãa]o\s*m[íi]nima|melhor que seu [úu]ltimo lance/.test(msg)) return 'intervalo-minimo';
  if (/abaixo.*m[íi]nimo|menor.*m[íi]nimo|valor.*m[íi]nimo/.test(msg))      return 'valor-baixo';
  if (/fase.*inv[áa]lid|encerrad|fora.*disputa|n[ãa]o.*permitido.*fase|item n[ãa]o est[áa] aberto|situa[çc][ãa]o do item/.test(msg)) return 'fase-invalida';
  return 'outro';
}

// Tipos que NÃO abortam o resto do batch. O laço da blitz consulta este set em
// vez de comparar com 'colisao' na mão.
const TIPOS_422_NAO_FATAIS = new Set(['colisao', 'intervalo-minimo']);

module.exports = SniperLance;
module.exports.TOKEN_MAX_AGE_S = TOKEN_MAX_AGE_S;
module.exports.TOKEN_SAFE_MARGIN_S = TOKEN_SAFE_MARGIN_S;
module.exports.buildCompraId = buildCompraId;
module.exports.classificar422 = classificar422;
module.exports.TIPOS_422_NAO_FATAIS = TIPOS_422_NAO_FATAIS;
