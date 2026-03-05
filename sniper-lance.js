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
const TOKEN_MAX_AGE_S = 600; // 10 minutos — tokens Comprasnet expiram por volta disso

const API_HEADERS = {
  'Accept': 'application/json, text/plain, */*',
  'Content-Type': 'application/json',
  'x-device-platform': 'web',
  'x-version-number': '6.0.0',
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
    this.bearerToken = token.startsWith('Bearer ') ? token : `Bearer ${token}`;
    this.tokenRecebidoEm = new Date().toISOString();
    this.tokenSource = source;
    this.log(`🔑 Bearer recebido (${source}): ${this.bearerToken.substring(0, 30)}...`);
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

  getToken() {
    if (!this.bearerToken) {
      throw new Error('Sem Bearer token. Abra o Comprasnet no Chrome com a extensão Token Relay.');
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
        const compraId = compra.compraId || `${compra.numeroUasg || ''}${compra.ano || ''}${compra.numero || ''}`;
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

  // ==================== MENSAGENS (HTTP direto) ====================

  /**
   * Captura mensagens de uma licitação via HTTP.
   * Requer Bearer + Captcha token.
   */
  async capturarMensagens(compraId, db) {
    if (!this.temCaptcha()) {
      throw new Error('Sem captcha token');
    }

    let pagina = 0;
    let totalNovas = 0;

    while (true) {
      const { status, data } = await this.apiGetCaptcha(
        `/comprasnet-mensagem/v2/chat/${compraId}?size=20&page=${pagina}&legadoAsp=false`
      );

      if (status !== 200 && status !== 206) {
        if (pagina === 0) this.log(`⚠️ Mensagens ${compraId}: HTTP ${status}`);
        break;
      }

      const mensagens = Array.isArray(data) ? data : [];
      if (mensagens.length === 0) break;

      for (const msg of mensagens) {
        const id = msg.id || msg.identificador;
        if (!id) continue;

        const existe = db.prepare('SELECT id FROM chat_mensagens WHERE mensagemId = ?').get(String(id));
        if (existe) continue;

        try {
          db.prepare(`INSERT INTO chat_mensagens
            (compraId, mensagemId, cnpjOrgao, ano, sequencial, dataHoraMensagem,
             remetente, conteudo, tipo, notificado)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`).run(
            compraId,
            String(id),
            msg.cnpjOrgao || '',
            msg.ano || 0,
            msg.sequencial || 0,
            msg.dataHora || msg.dataHoraMensagem || new Date().toISOString(),
            msg.remetente || msg.nomeRemetente || '',
            msg.mensagem || msg.conteudo || '',
            msg.tipo || 'MSG',
          );
          totalNovas++;
        } catch (e) {
          // Duplicate or schema mismatch — skip
        }
      }

      pagina++;
      if (mensagens.length < 20) break;
      await new Promise(r => setTimeout(r, 300));
    }

    if (totalNovas > 0) {
      this.log(`💬 ${compraId}: ${totalNovas} novas mensagens`);
    }
    return totalNovas;
  }

  /**
   * Captura mensagens de TODAS as participações ativas.
   */
  async capturarTodasMensagens(db) {
    const participacoes = db.prepare(
      'SELECT compraId FROM participacoes_comprasnet WHERE ativo = 1'
    ).all();

    this.log(`💬 Capturando mensagens de ${participacoes.length} participações...`);
    let total = 0;

    for (const p of participacoes) {
      try {
        total += await this.capturarMensagens(p.compraId, db);
      } catch (e) {
        // Skip silently
      }
    }

    this.log(`✅ Total: ${total} novas mensagens de ${participacoes.length} licitações`);
    return total;
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

module.exports = SniperLance;
