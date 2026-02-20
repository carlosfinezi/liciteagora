/**
 * MonitorV2 — Monitoramento de mensagens e participações via API direta do Comprasnet
 * 
 * Substitui a extensão-monitor (3.462 linhas) por chamadas HTTP diretas às APIs,
 * usando token hCaptcha gerado programaticamente via Chrome Remote Debugging.
 * 
 * Endpoints mapeados (HAR de 2026-02-19):
 *   - Mensagens:      GET /comprasnet-mensagem/v2/chat/{compraId}?size=20&page=0&legadoAsp=false&captcha={token}
 *   - Participações:  GET /comprasnet-fase-externa/v1/compras/participacoes?captcha={token}
 *   - Captcha config: GET /comprasnet-fase-externa/v1/captcha/configuracao
 *   - Itens seleção:  GET /comprasnet-fase-externa/v1/compras/{id}/itens/em-selecao-fornecedores?captcha={token}
 *   - WebSocket:      wss://cnetmobile.estaleiro.serpro.gov.br/comprasnet-websocket/socket/websocket
 * 
 * Categorias de mensagem:
 *   5  = Recurso/Intenção de recurso
 *   8  = Convocação para anexos (🔴 CRÍTICA — tem prazo)
 *   9  = Mensagem do pregoeiro (⚠️ importante)
 *   12 = Mensagem automática do sistema
 *   13 = Confirmação de envio de anexos
 *   14 = Mensagem de fornecedor
 * 
 * tipoRemetente:
 *   0 = Sistema
 *   1 = Fornecedor
 *   3 = Pregoeiro
 */

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const axios = require('axios');

const BASE_URL = 'https://cnetmobile.estaleiro.serpro.gov.br';
const HCAPTCHA_SITE_KEY = 'b8bbded1-9d04-4ace-9952-b67cde081a7b';
const DEBUGGING_PORT = parseInt(process.env.CHROME_DEBUG_PORT || '9223');

// Mapeamento de categorias para alertas
const CATEGORIAS = {
  '5':  { nome: 'Recurso',              emoji: '⚖️',  urgencia: 'alta' },
  '8':  { nome: 'Convocação Anexos',     emoji: '🔴', urgencia: 'critica' },
  '9':  { nome: 'Pregoeiro',            emoji: '📣', urgencia: 'alta' },
  '12': { nome: 'Sistema',              emoji: 'ℹ️',  urgencia: 'baixa' },
  '13': { nome: 'Confirmação Anexo',     emoji: '📎', urgencia: 'baixa' },
  '14': { nome: 'Fornecedor',           emoji: '💬', urgencia: 'media' },
};

const TIPO_REMETENTE = {
  '0': 'Sistema',
  '1': 'Fornecedor',
  '3': 'Pregoeiro',
};

class MonitorV2 {
  /**
   * @param {Object} db - instância better-sqlite3
   * @param {Object} options
   * @param {Function} options.enviarTelegram - função(mensagemHTML) para notificar
   * @param {Function} options.getConfigValue - função(chave) para ler config do banco
   * @param {number}   options.intervaloMinutos - intervalo entre verificações (padrão: 3)
   * @param {number}   options.tamanhoPagina - mensagens por página (padrão: 20)
   */
  constructor(db, options = {}) {
    this.db = db;
    this.enviarTelegram = options.enviarTelegram || (() => {});
    this.getConfigValue = options.getConfigValue || (() => null);
    this.intervaloMinutos = options.intervaloMinutos || 3;
    this.tamanhoPagina = options.tamanhoPagina || 20;

    this.browser = null;
    this.page = null;  // aba do Comprasnet
    this.ativo = false;
    this.intervalo = null;
    this.logs = [];

    // Status
    this.status = {
      chromeConectado: false,
      sessaoAtiva: false,
      ultimoToken: null,
      ultimaVerificacao: null,
      proximaVerificacao: null,
      ultimoErro: null,
      ciclosExecutados: 0,
      mensagensNovas: 0,
      participacoesAtivas: 0,
    };

    // Executar migrações ANTES de preparar statements (colunas novas precisam existir)
    this._executarMigracoes();
    // Preparar statements do banco
    this._prepararStatements();
  }

  // ==================== BANCO DE DADOS ====================

  _executarMigracoes() {
    try {
      // Adicionar colunas novas para dados da API v2
      const info = this.db.pragma('table_info(chat_mensagens)');
      const colunas = info.map(c => c.name);

      const migracoes = [
        { col: 'categoria',                sql: 'ALTER TABLE chat_mensagens ADD COLUMN categoria TEXT' },
        { col: 'tipoRemetente',            sql: 'ALTER TABLE chat_mensagens ADD COLUMN tipoRemetente TEXT' },
        { col: 'identificadorItem',        sql: 'ALTER TABLE chat_mensagens ADD COLUMN identificadorItem TEXT' },
        { col: 'identificadorDestinatario', sql: 'ALTER TABLE chat_mensagens ADD COLUMN identificadorDestinatario TEXT' },
        { col: 'identificadorRemetente',   sql: 'ALTER TABLE chat_mensagens ADD COLUMN identificadorRemetente TEXT' },
        { col: 'compraId',                 sql: 'ALTER TABLE chat_mensagens ADD COLUMN compraId TEXT' },
        { col: 'lido',                     sql: 'ALTER TABLE chat_mensagens ADD COLUMN lido INTEGER DEFAULT 0' },
        { col: 'dataLeitura',              sql: 'ALTER TABLE chat_mensagens ADD COLUMN dataLeitura TEXT' },
      ];

      for (const m of migracoes) {
        if (!colunas.includes(m.col)) {
          this.db.exec(m.sql);
          this.log(`[Migração] Coluna "${m.col}" adicionada a chat_mensagens`);
        }
      }

      // Adicionar colunas novas em participacoes_comprasnet
      const infoP = this.db.pragma('table_info(participacoes_comprasnet)');
      const colunasP = infoP.map(c => c.name);

      const migracoesP = [
        { col: 'modalidade',              sql: 'ALTER TABLE participacoes_comprasnet ADD COLUMN modalidade INTEGER' },
        { col: 'criterioJulgamento',      sql: 'ALTER TABLE participacoes_comprasnet ADD COLUMN criterioJulgamento TEXT' },
        { col: 'fundamentoLegal',         sql: 'ALTER TABLE participacoes_comprasnet ADD COLUMN fundamentoLegal TEXT' },
        { col: 'faseCompra',              sql: 'ALTER TABLE participacoes_comprasnet ADD COLUMN faseCompra TEXT' },
        { col: 'homologada',              sql: 'ALTER TABLE participacoes_comprasnet ADD COLUMN homologada INTEGER DEFAULT 0' },
        { col: 'possuiDiligencia',        sql: 'ALTER TABLE participacoes_comprasnet ADD COLUMN possuiDiligencia INTEGER DEFAULT 0' },
        { col: 'situacaoAnexos',          sql: 'ALTER TABLE participacoes_comprasnet ADD COLUMN situacaoAnexos TEXT' },
        { col: 'chaveCompraPncp',         sql: 'ALTER TABLE participacoes_comprasnet ADD COLUMN chaveCompraPncp TEXT' },
        { col: 'dadosCompletos',          sql: 'ALTER TABLE participacoes_comprasnet ADD COLUMN dadosCompletos TEXT' },
      ];

      for (const m of migracoesP) {
        if (!colunasP.includes(m.col)) {
          this.db.exec(m.sql);
          this.log(`[Migração] Coluna "${m.col}" adicionada a participacoes_comprasnet`);
        }
      }

    } catch (e) {
      this.log(`[Migração] Erro: ${e.message}`);
    }
  }

  _prepararStatements() {
    // Mensagens
    this.stmtMensagemExiste = this.db.prepare(
      'SELECT id FROM chat_mensagens WHERE hashMensagem = ?'
    );

    this.stmtInserirMensagem = this.db.prepare(`
      INSERT OR IGNORE INTO chat_mensagens 
        (cnpjOrgao, ano, sequencial, remetente, mensagem, dataHoraMensagem, hashMensagem,
         temCnpjFornecedor, notificado, categoria, tipoRemetente, identificadorItem,
         identificadorDestinatario, identificadorRemetente, compraId)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)
    `);

    // Participações
    this.stmtParticipacaoExiste = this.db.prepare(
      'SELECT id, situacao, etapa, faseCompra FROM participacoes_comprasnet WHERE compraId = ?'
    );

    this.stmtInserirParticipacao = this.db.prepare(`
      INSERT INTO participacoes_comprasnet 
        (compraId, cnpj, codigoUnidade, ano, sequencial, tipo, numero, orgao, objeto, 
         etapa, situacao, urlCompra, dataSessao, ativo, modalidade, criterioJulgamento,
         fundamentoLegal, faseCompra, homologada, possuiDiligencia, situacaoAnexos,
         chaveCompraPncp, dadosCompletos)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.stmtAtualizarParticipacao = this.db.prepare(`
      UPDATE participacoes_comprasnet SET
        situacao = ?, etapa = ?, faseCompra = ?, homologada = ?,
        possuiDiligencia = ?, situacaoAnexos = ?, objeto = ?,
        dadosCompletos = ?, dataAtualizacao = CURRENT_TIMESTAMP
      WHERE compraId = ?
    `);

    // Progresso de captura
    this.stmtProgressoExiste = this.db.prepare(
      'SELECT * FROM chat_captura_progresso WHERE compraId = ?'
    );

    this.stmtAtualizarProgresso = this.db.prepare(`
      INSERT OR REPLACE INTO chat_captura_progresso
        (compraId, cnpjOrgao, ano, sequencial, ultimaPaginaCapturada,
         totalMensagensCapturadas, capturaCompleta, ultimaCaptura, dataAtualizacao)
      VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `);

    // Palavras-chave
    this.stmtPalavrasChave = this.db.prepare(
      'SELECT palavra FROM chat_palavras_chave WHERE ativo = 1'
    );
  }

  // ==================== LOGGING ====================

  log(mensagem) {
    const timestamp = new Date().toLocaleTimeString('pt-BR');
    const entry = `[${timestamp}] ${mensagem}`;
    this.logs.push(entry);
    console.log(`[MonitorV2] ${mensagem}`);
    if (this.logs.length > 200) this.logs.shift();
  }

  getLogs(n = 50) {
    return this.logs.slice(-n);
  }

  getStatus() {
    return { ...this.status };
  }

  // ==================== CONEXÃO CHROME ====================

  /**
   * Conecta ao Chrome via Remote Debugging Protocol.
   * O Chrome deve estar aberto com --remote-debugging-port=9222
   */
  async conectarChrome() {
    try {
      this.log(`Conectando ao Chrome na porta ${DEBUGGING_PORT}...`);

      // Obter WebSocket endpoint
      const response = await axios.get(`http://127.0.0.1:${DEBUGGING_PORT}/json/version`, {
        timeout: 3000
      });
      const wsEndpoint = response.data.webSocketDebuggerUrl;

      // Conectar via Puppeteer
      this.browser = await puppeteer.connect({
        browserWSEndpoint: wsEndpoint,
        defaultViewport: null,
      });

      this.log('✅ Conectado ao Chrome');
      this.status.chromeConectado = true;

      // Encontrar aba do Comprasnet
      await this._encontrarAbaComprasnet();

      // Monitorar desconexão
      this.browser.on('disconnected', () => {
        this.log('⚠️ Chrome desconectou');
        this.status.chromeConectado = false;
        this.status.sessaoAtiva = false;
        this.browser = null;
        this.page = null;
      });

      return true;
    } catch (e) {
      this.log(`❌ Falha ao conectar: ${e.message}`);
      this.status.chromeConectado = false;
      this.status.ultimoErro = `Conexão Chrome: ${e.message}`;
      return false;
    }
  }

  /**
   * Encontra a aba do Comprasnet no Chrome conectado
   */
  async _encontrarAbaComprasnet() {
    const pages = await this.browser.pages();
    this.log(`Abas abertas: ${pages.length}`);

    // Prioridade: aba do cnetmobile logada
    this.page = pages.find(p => {
      const url = p.url();
      return url.includes('cnetmobile') &&
        !url.includes('acesso-nao-autorizado') &&
        (url.includes('/compras') || url.includes('/fornecedor'));
    });

    // Fallback: qualquer aba do cnetmobile
    if (!this.page) {
      this.page = pages.find(p =>
        p.url().includes('cnetmobile') && !p.url().includes('acesso-nao-autorizado')
      );
    }

    // Se não encontrou nenhuma aba do Comprasnet, navegar
    if (!this.page) {
      this.log('Nenhuma aba do Comprasnet encontrada, abrindo...');
      this.page = pages.find(p => p.url().includes('about:blank')) || await this.browser.newPage();
      await this.page.goto(`${BASE_URL}/comprasnet-web/seguro/fornecedor/compras`, {
        waitUntil: 'networkidle2',
        timeout: 30000,
      });
    }

    // Verificar se a sessão está ativa (não foi redirecionado para login)
    const url = this.page.url();
    this.log(`Aba selecionada: ${url.substring(0, 80)}`);

    if (url.includes('acesso-nao-autorizado') || url.includes('login') || url.includes('sso.acesso.gov.br')) {
      this.log('⚠️ Sessão expirada — necessário login manual');
      this.status.sessaoAtiva = false;
      await this.enviarTelegram('⚠️ <b>LiciteAgora:</b> Sessão do Comprasnet expirou. Faça login manualmente no Chrome.');
      return false;
    }

    this.status.sessaoAtiva = true;
    return true;
  }

  /**
   * Tenta reconectar ao Chrome. Chamado automaticamente quando a conexão cai.
   */
  async reconectar() {
    this.log('Tentando reconectar ao Chrome...');
    for (let tentativa = 1; tentativa <= 3; tentativa++) {
      const ok = await this.conectarChrome();
      if (ok) return true;
      this.log(`Tentativa ${tentativa}/3 falhou, aguardando 10s...`);
      await this._aguardar(10000);
    }
    this.log('❌ Não foi possível reconectar após 3 tentativas');
    await this.enviarTelegram('❌ <b>LiciteAgora:</b> Não foi possível conectar ao Chrome. Verifique se está aberto com Remote Debugging.');
    return false;
  }

  // ==================== hCAPTCHA ====================

  /**
   * Gera um token hCaptcha via page.evaluate() na aba do Comprasnet.
   * Cada token é de uso único.
   */
  async gerarTokenCaptcha() {
    if (!this.page) {
      throw new Error('Sem página conectada ao Comprasnet');
    }

    try {
      const token = await this.page.evaluate(async (siteKey) => {
        // Verificar se hcaptcha está carregado
        if (typeof hcaptcha === 'undefined') {
          throw new Error('hcaptcha não está carregado na página');
        }

        // Tentar encontrar widget existente
        const widgetEl = document.querySelector('[data-hcaptcha-widget-id]');
        let widgetId;

        if (widgetEl) {
          widgetId = widgetEl.getAttribute('data-hcaptcha-widget-id');
        } else {
          // Buscar o primeiro widget registrado
          // hcaptcha mantém widgets internamente
          const frames = document.querySelectorAll('iframe[src*="hcaptcha"]');
          if (frames.length > 0) {
            // Widget existe mas sem atributo — tentar execute com sitekey
            const result = await hcaptcha.execute({ sitekey: siteKey, async: true });
            return result.response;
          }
          throw new Error('Nenhum widget hCaptcha encontrado na página');
        }

        const result = await hcaptcha.execute(widgetId, { async: true });
        return result.response;
      }, HCAPTCHA_SITE_KEY);

      if (!token || !token.startsWith('P1_')) {
        throw new Error(`Token inválido: ${(token || '').substring(0, 20)}`);
      }

      this.status.ultimoToken = new Date().toISOString();
      return token;
    } catch (e) {
      // Se falhar, pode ser que a sessão expirou
      const url = this.page.url();
      if (url.includes('acesso-nao-autorizado') || url.includes('login')) {
        this.status.sessaoAtiva = false;
        throw new Error('Sessão expirada — necessário login manual');
      }
      throw new Error(`Falha ao gerar token hCaptcha: ${e.message}`);
    }
  }

  // ==================== API: PARTICIPAÇÕES ====================

  /**
   * Sincroniza participações do fornecedor via API do Comprasnet.
   * Endpoint: GET /comprasnet-fase-externa/v1/compras/participacoes?captcha={token}
   */
  async syncParticipacoes() {
    this.log('Sincronizando participações...');

    const token = await this.gerarTokenCaptcha();
    const url = `${BASE_URL}/comprasnet-fase-externa/v1/compras/participacoes?captcha=${token}`;

    // Fazer a chamada via page.evaluate para usar cookies da sessão
    const dados = await this.page.evaluate(async (apiUrl) => {
      const resp = await fetch(apiUrl, {
        credentials: 'include',
        headers: { 'Accept': 'application/json' },
      });
      if (!resp.ok && resp.status !== 206) {
        throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
      }
      return resp.json();
    }, url);

    if (!Array.isArray(dados)) {
      this.log(`⚠️ Resposta inesperada da API de participações: ${typeof dados}`);
      return [];
    }

    this.log(`Recebidas ${dados.length} participações da API`);

    let novas = 0;
    let atualizadas = 0;

    for (const item of dados) {
      const compra = item.compra;
      const compraId = this._montarCompraId(compra);

      const existente = this.stmtParticipacaoExiste.get(compraId);

      if (!existente) {
        // Nova participação
        this.stmtInserirParticipacao.run(
          compraId,
          String(compra.numeroUasg),
          String(compra.numeroUasg),
          compra.ano,
          compra.numero,
          this._mapearModalidade(compra.modalidade),
          String(compra.numero),
          compra.nomeOrgao || compra.nomeUasg || '',
          compra.objetoCompra || '',
          compra.faseCompraFaseExterna || '',
          compra.situacaoCompraFaseExterna || '',
          `${BASE_URL}/comprasnet-web/seguro/fornecedor/compras?compra=${compraId}`,
          compra.dataHoraAbertura || '',
          compra.modalidade,
          compra.criterioJulgamento || '',
          compra.fundamentoLegal || '',
          compra.faseCompraFaseExterna || '',
          compra.homologada ? 1 : 0,
          item.possuiDiligenciaEmAndamento ? 1 : 0,
          item.situacaoUltimaSolicitacaoAnexos || '',
          compra.chaveCompraPncp || '',
          JSON.stringify(item),
        );
        novas++;
      } else {
        // Verificar mudanças
        const faseNova = compra.faseCompraFaseExterna || '';
        const situacaoNova = compra.situacaoCompraFaseExterna || '';

        if (existente.situacao !== situacaoNova || existente.faseCompra !== faseNova) {
          this.log(`📋 Mudança de fase: ${compraId} → fase=${faseNova} sit=${situacaoNova}`);
        }

        this.stmtAtualizarParticipacao.run(
          situacaoNova,
          compra.faseCompraFaseExterna || existente.etapa,
          faseNova,
          compra.homologada ? 1 : 0,
          item.possuiDiligenciaEmAndamento ? 1 : 0,
          item.situacaoUltimaSolicitacaoAnexos || '',
          compra.objetoCompra || '',
          JSON.stringify(item),
          compraId,
        );
        atualizadas++;
      }
    }

    this.status.participacoesAtivas = dados.length;
    this.log(`✅ Participações: ${novas} novas, ${atualizadas} atualizadas, ${dados.length} total`);

    return dados;
  }

  // ==================== API: MENSAGENS ====================

  /**
   * Captura mensagens de uma licitação via API.
   * Endpoint: GET /comprasnet-mensagem/v2/chat/{compraId}?size=20&page=0&legadoAsp=false&captcha={token}
   * 
   * @param {string} compraId - ID da compra (ex: 98998305900882025)
   * @param {Object} infoCompra - { cnpjOrgao, ano, sequencial, orgao, objeto }
   * @param {boolean} capturaCompleta - se true, pagina até o fim; se false, só página 0
   * @returns {number} quantidade de mensagens novas inseridas
   */
  async capturarMensagens(compraId, infoCompra, capturaCompleta = false) {
    const progresso = this.stmtProgressoExiste.get(compraId);

    // Se já tem captura completa, só verificar página 0 (mais recentes)
    if (progresso && progresso.capturaCompleta && !capturaCompleta) {
      return await this._capturarPaginasMensagens(compraId, infoCompra, 0, 0);
    }

    // Captura completa: paginar até acabar
    if (!progresso || !progresso.capturaCompleta) {
      this.log(`📥 Captura completa de mensagens para ${compraId}...`);
      return await this._capturarPaginasMensagens(compraId, infoCompra, 0, -1);
    }

    return 0;
  }

  /**
   * Captura páginas de mensagens da API.
   * @param {number} paginaInicial
   * @param {number} paginaFinal - se -1, pagina até array vazio
   */
  async _capturarPaginasMensagens(compraId, infoCompra, paginaInicial, paginaFinal) {
    let pagina = paginaInicial;
    let totalNovas = 0;
    let totalCapturadas = 0;
    let paginasProcessadas = 0;

    while (true) {
      // Gerar novo token para cada página
      const token = await this.gerarTokenCaptcha();
      const url = `${BASE_URL}/comprasnet-mensagem/v2/chat/${compraId}?size=${this.tamanhoPagina}&page=${pagina}&legadoAsp=false&captcha=${token}`;

      let mensagens;
      try {
        mensagens = await this.page.evaluate(async (apiUrl) => {
          const resp = await fetch(apiUrl, {
            credentials: 'include',
            headers: { 'Accept': 'application/json' },
          });
          if (!resp.ok && resp.status !== 206) {
            throw new Error(`HTTP ${resp.status}`);
          }
          return resp.json();
        }, url);
      } catch (e) {
        this.log(`⚠️ Erro ao buscar página ${pagina}: ${e.message}`);
        break;
      }

      if (!Array.isArray(mensagens) || mensagens.length === 0) {
        // Fim da paginação
        break;
      }

      // Processar mensagens
      for (const msg of mensagens) {
        const nova = this._processarMensagem(msg, compraId, infoCompra);
        if (nova) totalNovas++;
        totalCapturadas++;
      }

      paginasProcessadas++;

      // Se só queria uma página (incremental)
      if (paginaFinal === 0) break;

      // Se não encontrou nenhuma nova nesta página e é incremental (todas já existiam)
      if (paginaFinal === 0 && totalNovas === 0) break;

      pagina++;

      // Pausa entre páginas para não sobrecarregar
      await this._aguardar(500);
    }

    // Atualizar progresso
    const capturaFoi = paginaFinal !== 0; // captura completa
    this.stmtAtualizarProgresso.run(
      compraId,
      infoCompra.cnpjOrgao || '',
      infoCompra.ano || 0,
      infoCompra.sequencial || 0,
      pagina,
      totalCapturadas,
      capturaFoi ? 1 : (this.stmtProgressoExiste.get(compraId)?.capturaCompleta || 0),
    );

    if (totalNovas > 0) {
      this.log(`💬 ${compraId}: ${totalNovas} novas mensagens (${paginasProcessadas} páginas)`);
    }

    return totalNovas;
  }

  /**
   * Processa uma mensagem da API e insere no banco se for nova.
   * @returns {boolean} true se a mensagem é nova
   */
  _processarMensagem(msg, compraId, infoCompra) {
    const hash = msg.chaveMensagemNaOrigem;
    if (!hash) return false;

    // Verificar se já existe
    if (this.stmtMensagemExiste.get(hash)) {
      return false;
    }

    // Determinar remetente
    const tipoRem = TIPO_REMETENTE[msg.tipoRemetente] || 'Desconhecido';
    let remetente = tipoRem;
    if (msg.identificadorRemetente) {
      remetente = `${tipoRem} (${msg.identificadorRemetente})`;
    }

    // Verificar se menciona CNPJ do fornecedor
    const cnpjFornecedor = this.getConfigValue('cnpj_fornecedor') || '';
    const temCnpj = cnpjFornecedor &&
      (msg.identificadorDestinatario === cnpjFornecedor ||
       msg.texto?.includes(cnpjFornecedor)) ? 1 : 0;

    // Extrair dados da chave da compra
    const chave = msg.chaveCompra || {};
    const cnpjOrgao = infoCompra.cnpjOrgao || String(chave.numeroUasg || '');
    const ano = infoCompra.ano || chave.ano || 0;
    const sequencial = infoCompra.sequencial || chave.numero || 0;

    // Inserir
    try {
      this.stmtInserirMensagem.run(
        cnpjOrgao,
        ano,
        sequencial,
        remetente,
        msg.texto || '',
        msg.dataHora || '',
        hash,
        temCnpj,
        msg.categoria || '',
        msg.tipoRemetente || '',
        msg.identificadorItem || null,
        msg.identificadorDestinatario || null,
        msg.identificadorRemetente || null,
        compraId,
      );
    } catch (e) {
      // UNIQUE constraint = duplicata, ignorar
      if (!e.message.includes('UNIQUE')) {
        this.log(`⚠️ Erro ao inserir mensagem: ${e.message}`);
      }
      return false;
    }

    return true;
  }

  // ==================== ALERTAS ====================

  /**
   * Envia notificação Telegram para mensagens novas, com prioridade por categoria.
   */
  async _notificarMensagensNovas(compraId, infoCompra, mensagensNovas) {
    if (mensagensNovas.length === 0) return;

    const cnpjFornecedor = this.getConfigValue('cnpj_fornecedor') || '';
    const palavrasChave = this.stmtPalavrasChave.all().map(p => p.palavra.toLowerCase());

    for (const msg of mensagensNovas) {
      const cat = CATEGORIAS[msg.categoria] || { nome: 'Outro', emoji: '📨', urgencia: 'media' };
      const texto = msg.texto || '';

      // Verificar se é direcionada ao fornecedor
      const direcionada = msg.identificadorDestinatario === cnpjFornecedor;

      // Verificar palavras-chave
      const textoLower = texto.toLowerCase();
      const palavrasEncontradas = palavrasChave.filter(p => textoLower.includes(p));

      // Decidir se notifica
      const deveNotificar =
        direcionada ||                        // sempre se direcionada ao fornecedor
        cat.urgencia === 'critica' ||         // sempre se crítica (convocação)
        cat.urgencia === 'alta' ||            // pregoeiro e recurso
        palavrasEncontradas.length > 0 ||     // palavras-chave
        msg.tipoRemetente === '3';            // pregoeiro

      if (!deveNotificar) continue;

      // Montar mensagem Telegram
      let telegram = '';

      if (cat.urgencia === 'critica' || direcionada) {
        telegram += `🔴 <b>ATENÇÃO — ${cat.nome.toUpperCase()}</b>\n`;
      } else {
        telegram += `${cat.emoji} <b>${cat.nome}</b>\n`;
      }

      telegram += `━━━━━━━━━━━━━━━\n`;
      telegram += `🏛️ ${infoCompra.orgao || 'Órgão'}\n`;
      telegram += `📋 Licitação ${infoCompra.sequencial}/${infoCompra.ano}\n`;

      if (msg.identificadorItem) {
        telegram += `📦 Item ${msg.identificadorItem}\n`;
      }

      telegram += `\n💬 ${texto.length > 400 ? texto.substring(0, 400) + '...' : texto}\n`;

      if (direcionada) {
        telegram += `\n⚠️ <b>DIRECIONADA AO SEU CNPJ</b>\n`;
      }

      if (palavrasEncontradas.length > 0) {
        telegram += `🔔 Palavras-chave: ${palavrasEncontradas.join(', ')}\n`;
      }

      // Extrair prazo da convocação (categoria 8)
      if (msg.categoria === '8') {
        const matchPrazo = texto.match(/Prazo.*?:\s*(.+?)(?:\.|$)/i);
        if (matchPrazo) {
          telegram += `\n⏰ <b>Prazo: ${matchPrazo[1]}</b>\n`;
        }
      }

      try {
        await this.enviarTelegram(telegram);
        // Marcar como notificado
        this.db.prepare('UPDATE chat_mensagens SET notificado = 1 WHERE hashMensagem = ?')
          .run(msg.chaveMensagemNaOrigem);
      } catch (e) {
        this.log(`⚠️ Erro ao enviar Telegram: ${e.message}`);
      }

      // Pausa entre notificações para não ser rate-limited
      await this._aguardar(200);
    }
  }

  // ==================== LOOP PRINCIPAL ====================

  /**
   * Inicia o monitoramento contínuo.
   */
  async iniciar() {
    if (this.ativo) {
      this.log('Monitor já está ativo');
      return { success: true, message: 'Já está ativo' };
    }

    // Conectar ao Chrome
    const conectado = await this.conectarChrome();
    if (!conectado) {
      return { success: false, message: 'Não foi possível conectar ao Chrome' };
    }

    this.ativo = true;
    this.log('🟢 Monitor V2 iniciado');

    // Executar primeiro ciclo imediatamente
    await this._executarCiclo();

    // Agendar ciclos seguintes
    this.intervalo = setInterval(async () => {
      if (this.ativo) {
        await this._executarCiclo();
      }
    }, this.intervaloMinutos * 60 * 1000);

    this.status.proximaVerificacao = new Date(
      Date.now() + this.intervaloMinutos * 60 * 1000
    ).toISOString();

    return { success: true, message: `Monitoramento iniciado (a cada ${this.intervaloMinutos} min)` };
  }

  /**
   * Para o monitoramento.
   */
  parar() {
    this.ativo = false;
    if (this.intervalo) {
      clearInterval(this.intervalo);
      this.intervalo = null;
    }
    this.log('🔴 Monitor V2 parado');
    return { success: true, message: 'Monitoramento parado' };
  }

  /**
   * Executa um ciclo completo de monitoramento.
   */
  async _executarCiclo() {
    const inicio = Date.now();
    this.log('─── Início do ciclo ───');

    try {
      // Verificar conexão
      if (!this.browser || !this.browser.isConnected()) {
        this.log('Chrome desconectado, tentando reconectar...');
        const ok = await this.reconectar();
        if (!ok) return;
      }

      // Verificar sessão
      const sessaoOk = await this._verificarSessao();
      if (!sessaoOk) {
        this.log('⚠️ Sessão inválida, pulando ciclo');
        return;
      }

      // 1. Sincronizar participações (a cada 5 ciclos = ~15 min)
      if (this.status.ciclosExecutados % 5 === 0) {
        try {
          await this.syncParticipacoes();
        } catch (e) {
          this.log(`⚠️ Erro sync participações: ${e.message}`);
        }
      }

      // 2. Buscar licitações ativas para monitorar
      const participacoes = this.db.prepare(
        'SELECT * FROM participacoes_comprasnet WHERE ativo = 1'
      ).all();

      if (participacoes.length === 0) {
        this.log('Nenhuma participação ativa para monitorar');
        this.status.ciclosExecutados++;
        return;
      }

      // 3. Para cada licitação, capturar mensagens novas
      let totalNovas = 0;

      for (const p of participacoes) {
        try {
          const infoCompra = {
            cnpjOrgao: p.cnpj,
            ano: p.ano,
            sequencial: p.sequencial,
            orgao: p.orgao,
            objeto: p.objeto,
          };

          // Verificar se já tem captura completa
          const progresso = this.stmtProgressoExiste.get(p.compraId);
          const primeiraVez = !progresso || !progresso.capturaCompleta;

          const novas = await this.capturarMensagens(p.compraId, infoCompra, primeiraVez);
          totalNovas += novas;

          if (novas > 0) {
            // Buscar as mensagens recém-inseridas para notificar
            const recentes = this.db.prepare(
              `SELECT * FROM chat_mensagens 
               WHERE compraId = ? AND notificado = 0
               ORDER BY dataHoraMensagem DESC`
            ).all(p.compraId);

            await this._notificarMensagensNovas(p.compraId, infoCompra, recentes);
          }

          // Pausa entre licitações
          await this._aguardar(1000);
        } catch (e) {
          this.log(`⚠️ Erro em ${p.compraId}: ${e.message}`);
          // Se for erro de sessão, parar o ciclo
          if (e.message.includes('Sessão expirada')) {
            break;
          }
        }
      }

      // Atualizar status
      this.status.ciclosExecutados++;
      this.status.mensagensNovas += totalNovas;
      this.status.ultimaVerificacao = new Date().toISOString();
      this.status.proximaVerificacao = new Date(
        Date.now() + this.intervaloMinutos * 60 * 1000
      ).toISOString();

      const duracao = ((Date.now() - inicio) / 1000).toFixed(1);
      this.log(`─── Ciclo #${this.status.ciclosExecutados}: ${totalNovas} novas, ${participacoes.length} licitações, ${duracao}s ───`);

    } catch (e) {
      this.log(`❌ Erro no ciclo: ${e.message}`);
      this.status.ultimoErro = e.message;
    }
  }

  /**
   * Verifica se a sessão do Comprasnet ainda está ativa.
   */
  async _verificarSessao() {
    try {
      if (!this.page) return false;

      const url = this.page.url();
      if (url.includes('acesso-nao-autorizado') || url.includes('login') || url.includes('sso.acesso.gov.br')) {
        this.status.sessaoAtiva = false;
        await this.enviarTelegram('⚠️ <b>LiciteAgora:</b> Sessão do Comprasnet expirou. Faça login manualmente.');
        return false;
      }

      this.status.sessaoAtiva = true;
      return true;
    } catch (e) {
      this.log(`⚠️ Erro ao verificar sessão: ${e.message}`);
      return false;
    }
  }

  // ==================== UTILIDADES ====================

  /**
   * Monta o compraId a partir dos dados da compra.
   * Formato: {uasg:6}{modalidade:02d}{numero:5}{ano:4} = 17 dígitos
   */
  _montarCompraId(compra) {
    const uasg = String(compra.numeroUasg).padStart(6, '0');
    const mod = String(compra.modalidade).padStart(2, '0');
    const num = String(compra.numero).padStart(5, '0');
    const ano = String(compra.ano);
    return `${uasg}${mod}${num}${ano}`;
  }

  /**
   * Mapeia código de modalidade para nome.
   */
  _mapearModalidade(codigo) {
    const map = {
      5: 'Pregão Eletrônico',
      6: 'Dispensa Eletrônica',
      8: 'Concorrência Eletrônica',
    };
    return map[codigo] || `Modalidade ${codigo}`;
  }

  _aguardar(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = MonitorV2;
