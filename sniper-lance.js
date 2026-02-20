/**
 * sniper-lance.js — Sistema de lance sniper para Comprasnet
 * 
 * Envia lance nos últimos milissegundos antes do encerramento.
 * Usa Bearer token capturado pelo MonitorV2 via CDP.
 * 
 * API Comprasnet:
 *   POST /comprasnet-disputa/v1/compras/{compraId}/itens/{itemNumero}/lances
 *   Body: { valorInformado: number, faseItem: "LA" }
 *   Headers: Authorization: Bearer ..., x-device-platform: web, x-version-number: 5.5.2
 */

const BASE_URL = 'https://cnetmobile.estaleiro.serpro.gov.br';

class SniperLance {
  constructor(monitorV2) {
    this.monitor = monitorV2; // referência ao MonitorV2 para Bearer token
    this.agendamentos = new Map(); // id -> { timer, config }
    this.historico = []; // últimos 50 lances
    this.logs = [];
    this.maxLogs = 100;

    // Offset de tempo servidor vs local (calibrado via API)
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

  // ==================== CALIBRAÇÃO DE TEMPO ====================

  /**
   * Calibra o offset entre o relógio local e o do servidor Comprasnet.
   * Usa o endpoint /comprasnet-disputa/v1/datahorabrasilia
   */
  async calibrarTempo() {
    try {
      const antes = Date.now();

      const resultado = await this.monitor.page.evaluate(async (baseUrl) => {
        const resp = await fetch(`${baseUrl}/comprasnet-disputa/v1/datahorabrasilia`, {
          credentials: 'include',
        });
        return await resp.text();
      }, BASE_URL);

      const depois = Date.now();
      const latencia = depois - antes;
      const meioLatencia = Math.floor(latencia / 2);

      // resultado é timestamp do servidor
      const tempoServidor = new Date(resultado.replace(/"/g, '')).getTime();
      const tempoLocal = antes + meioLatencia;
      this.offsetServidorMs = tempoServidor - tempoLocal;
      this.ultimaCalibracao = new Date().toISOString();

      this.log(`🕐 Calibração: offset=${this.offsetServidorMs}ms, latência=${latencia}ms`);
      return {
        offset: this.offsetServidorMs,
        latencia,
        tempoServidor: new Date(tempoServidor).toISOString(),
      };
    } catch (e) {
      this.log(`⚠️ Erro calibração: ${e.message}`);
      throw e;
    }
  }

  /**
   * Retorna o tempo atual do servidor (estimado)
   */
  tempoServidorAgora() {
    return Date.now() + this.offsetServidorMs;
  }

  // ==================== ENVIO DE LANCE ====================

  /**
   * Envia um lance imediatamente via API.
   * 
   * @param {string} compraId - ex: "93119906000012026"
   * @param {number} itemNumero - ex: 1
   * @param {number} valor - ex: 1745.00
   * @param {string} faseItem - ex: "LA" (lance aberto)
   * @returns {Object} resultado
   */
  async enviarLance(compraId, itemNumero, valor, faseItem = 'LA') {
    const bearerToken = await this.monitor._obterBearerToken();
    const url = `${BASE_URL}/comprasnet-disputa/v1/compras/${compraId}/itens/${itemNumero}/lances`;

    const inicio = Date.now();

    const resultado = await this.monitor.page.evaluate(async (apiUrl, authToken, body) => {
      try {
        const resp = await fetch(apiUrl, {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Accept': 'application/json, text/plain, */*',
            'Content-Type': 'application/json',
            'Authorization': authToken,
            'x-device-platform': 'web',
            'x-version-number': '5.5.2',
            'Cache-Control': 'no-cache, no-store, max-age=0, must-revalidate',
          },
          body: JSON.stringify(body),
        });
        const text = await resp.text();
        return { status: resp.status, body: text };
      } catch (e) {
        return { status: 0, body: e.message };
      }
    }, url, bearerToken, { valorInformado: valor, faseItem });

    const tempoMs = Date.now() - inicio;

    const lance = {
      compraId,
      itemNumero,
      valor,
      faseItem,
      status: resultado.status,
      resposta: resultado.body.substring(0, 500),
      tempoMs,
      timestamp: new Date().toISOString(),
      sucesso: resultado.status === 200 || resultado.status === 201,
    };

    this.historico.unshift(lance);
    if (this.historico.length > 50) this.historico.pop();

    if (lance.sucesso) {
      this.log(`🎯 LANCE ENVIADO! R$ ${valor.toFixed(2)} item ${itemNumero} (${tempoMs}ms)`);
    } else {
      this.log(`❌ Lance falhou: HTTP ${resultado.status} - ${resultado.body.substring(0, 100)} (${tempoMs}ms)`);
    }

    return lance;
  }

  // ==================== AGENDAMENTO SNIPER ====================

  /**
   * Agenda um lance para ser disparado em um horário exato.
   * 
   * @param {Object} config
   * @param {string} config.id - ID único do agendamento
   * @param {string} config.compraId - ID da compra
   * @param {number} config.itemNumero - número do item
   * @param {number} config.valor - valor do lance
   * @param {string} config.faseItem - fase do item (default "LA")
   * @param {string} config.horarioAlvo - ISO timestamp de quando disparar
   * @param {number} config.antecedenciaMs - ms antes do horário alvo (default 500)
   * @param {number} config.tentativas - quantas tentativas em sequência (default 3)
   * @param {number} config.intervaloTentativasMs - ms entre tentativas (default 200)
   */
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

    // Cancelar agendamento anterior se existir
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

      // Calibrar Bearer token antes de disparar
      try {
        await this.monitor._obterBearerToken();
      } catch (e) {
        this.log(`⚠️ Erro ao obter Bearer antes do disparo: ${e.message}`);
      }

      const resultados = [];

      for (let t = 0; t < tentativas; t++) {
        try {
          const resultado = await this.enviarLance(compraId, itemNumero, valor, faseItem);
          resultados.push(resultado);

          if (resultado.sucesso) {
            this.log(`✅ Tentativa ${t + 1}/${tentativas}: SUCESSO em ${resultado.tempoMs}ms`);
            break; // Sucesso, não precisa mais tentativas
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

      // Salvar resultado
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

  /**
   * Cancela um agendamento.
   */
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

  /**
   * Lista todos os agendamentos ativos.
   */
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

  /**
   * Retorna status geral do sniper.
   */
  getStatus() {
    return {
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
