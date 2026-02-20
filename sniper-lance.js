/**
 * sniper-lance.js — Sistema de lance sniper para Comprasnet
 * 
 * Envia lances via chamadas HTTP diretas usando Bearer token.
 * O token é recebido da extensão Chrome (Token Relay).
 * NÃO depende de Puppeteer, CDP ou túnel SSH.
 * 
 * API Comprasnet:
 *   POST /comprasnet-disputa/v1/compras/{compraId}/itens/{itemNumero}/lances
 *   Body: { valorInformado: number, faseItem: "LA" }
 *   Headers: Authorization: Bearer ..., x-device-platform: web, x-version-number: 5.5.2
 */

const axios = require('axios');

const BASE_URL = 'https://cnetmobile.estaleiro.serpro.gov.br';

const API_HEADERS = {
  'Accept': 'application/json, text/plain, */*',
  'Content-Type': 'application/json',
  'x-device-platform': 'web',
  'x-version-number': '5.5.2',
  'Cache-Control': 'no-cache, no-store, max-age=0, must-revalidate',
};

class SniperLance {
  constructor() {
    this.bearerToken = null;          // "Bearer eyJ..."
    this.tokenRecebidoEm = null;      // timestamp
    this.tokenSource = null;           // 'extension' | 'manual' | 'monitor'

    this.agendamentos = new Map();     // id -> { timer, config }
    this.historico = [];               // últimos 50 lances
    this.logs = [];
    this.maxLogs = 100;

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
  setToken(token, source = 'manual') {
    if (!token) return;
    // Normalizar
    this.bearerToken = token.startsWith('Bearer ') ? token : `Bearer ${token}`;
    this.tokenRecebidoEm = new Date().toISOString();
    this.tokenSource = source;
    this.log(`🔑 Token recebido (${source}): ${this.bearerToken.substring(0, 30)}...`);
  }

  /**
   * Retorna o Bearer token atual ou lança erro.
   */
  getToken() {
    if (!this.bearerToken) {
      throw new Error('Sem Bearer token. Abra o Comprasnet no Chrome com a extensão Token Relay.');
    }
    return this.bearerToken;
  }

  /**
   * Verifica se tem token válido.
   */
  temToken() {
    return !!this.bearerToken;
  }

  /**
   * Idade do token em segundos.
   */
  idadeTokenSegundos() {
    if (!this.tokenRecebidoEm) return Infinity;
    return (Date.now() - new Date(this.tokenRecebidoEm).getTime()) / 1000;
  }

  // ==================== HTTP HELPERS ====================

  /**
   * Faz uma requisição GET autenticada ao Comprasnet.
   */
  async apiGet(path) {
    const token = this.getToken();
    const url = `${BASE_URL}${path}`;
    const resp = await axios.get(url, {
      headers: { ...API_HEADERS, Authorization: token },
      timeout: 10000,
      validateStatus: () => true, // não lançar em 4xx/5xx
    });
    return { status: resp.status, data: resp.data };
  }

  /**
   * Faz uma requisição POST autenticada ao Comprasnet.
   */
  async apiPost(path, body) {
    const token = this.getToken();
    const url = `${BASE_URL}${path}`;
    const resp = await axios.post(url, body, {
      headers: { ...API_HEADERS, Authorization: token },
      timeout: 10000,
      validateStatus: () => true,
    });
    return { status: resp.status, data: resp.data };
  }

  // ==================== CALIBRAÇÃO DE TEMPO ====================

  /**
   * Calibra o offset entre o relógio local e o do servidor Comprasnet.
   */
  async calibrarTempo() {
    try {
      const antes = Date.now();

      const { status, data } = await this.apiGet('/comprasnet-disputa/v1/datahorabrasilia');

      const depois = Date.now();
      const latencia = depois - antes;
      const meioLatencia = Math.floor(latencia / 2);

      if (status !== 200) {
        throw new Error(`HTTP ${status}: ${JSON.stringify(data).substring(0, 100)}`);
      }

      const raw = typeof data === 'string' ? data.replace(/"/g, '').trim() : String(data);
      this.log(`🕐 Resposta raw: ${raw}`);

      let tempoServidor;
      if (/^\d{13}$/.test(raw)) {
        tempoServidor = parseInt(raw);
      } else if (/^\d{10}$/.test(raw)) {
        tempoServidor = parseInt(raw) * 1000;
      } else {
        tempoServidor = new Date(raw).getTime();
      }

      if (isNaN(tempoServidor)) {
        throw new Error(`Formato não reconhecido: ${raw}`);
      }

      const tempoLocal = antes + meioLatencia;
      this.offsetServidorMs = tempoServidor - tempoLocal;
      this.ultimaCalibracao = new Date().toISOString();

      this.log(`🕐 Calibração: offset=${this.offsetServidorMs}ms, latência=${latencia}ms`);
      return { offset: this.offsetServidorMs, latencia, tempoServidor: new Date(tempoServidor).toISOString() };
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
   */
  async enviarLance(compraId, itemNumero, valor, faseItem = 'LA') {
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
      resposta: resposta.substring(0, 500),
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

      for (let t = 0; t < tentativas; t++) {
        try {
          const resultado = await this.enviarLance(compraId, itemNumero, valor, faseItem);
          resultados.push(resultado);

          if (resultado.sucesso) {
            this.log(`✅ Tentativa ${t + 1}/${tentativas}: SUCESSO em ${resultado.tempoMs}ms`);
            break;
          } else {
            this.log(`⚠️ Tentativa ${t + 1}/${tentativas}: falhou (${resultado.status})`);
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
   */
  async consultarItens(compraId) {
    this.log(`🔍 Consultando itens da disputa ${compraId}...`);

    const endpoints = [
      `/comprasnet-fase-externa/v1/compras/${compraId}/itens/em-selecao-fornecedores`,
      `/comprasnet-disputa/v1/compras/${compraId}/itens`,
    ];

    for (const path of endpoints) {
      try {
        const { status, data } = await this.apiGet(path);

        if (status === 200 || status === 206) {
          const itens = Array.isArray(data) ? data : [data];
          this.log(`✅ Consulta OK: ${itens.length} itens (${path.includes('fase-externa') ? 'fase-externa' : 'disputa'})`);
          return { success: true, itens, endpoint: path };
        } else {
          this.log(`⚠️ ${path.split('/v1/')[1]?.substring(0, 40)} → HTTP ${status}`);
        }
      } catch (e) {
        this.log(`⚠️ Erro em ${path}: ${e.message}`);
      }
    }

    throw new Error('Nenhum endpoint retornou dados válidos');
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
        // Silently skip — not all participações are in disputa
      }
    }

    this.log(`✅ ${disputasAtivas.length} disputas ativas encontradas`);
    return disputasAtivas;
  }

  // ==================== STATUS ====================

  getStatus() {
    return {
      ativo: true,
      temToken: this.temToken(),
      tokenSource: this.tokenSource,
      tokenIdade: this.tokenRecebidoEm ? Math.floor(this.idadeTokenSegundos()) + 's' : null,
      tokenRecebidoEm: this.tokenRecebidoEm,
      agendamentosAtivos: [...this.agendamentos.values()].filter(a => !a.executado).length,
      agendamentosTotal: this.agendamentos.size,
      ultimaCalibracao: this.ultimaCalibracao,
      offsetServidorMs: this.offsetServidorMs,
      tempoServidorEstimado: new Date(this.tempoServidorAgora()).toISOString(),
      lancesEnviados: this.historico.length,
    };
  }
}

module.exports = SniperLance;
