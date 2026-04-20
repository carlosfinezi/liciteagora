const express = require('express');
const cors = require('cors');
const axios = require('axios');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
// NFSE-M06 onda 5C: criarVerificador só era usado pelo motor PNCP; agora é
// instanciado internamente em pncp-sync-scheduler.js. Removido daqui.
const crypto = require('crypto');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { createSessionStore, criarUsuarioInicial, getSessionSecret, getApiKey, requireAuth } = require('./auth');
const { registrarRotasUsuarios } = require('./usuarios-routes');
const { registrarRotasAuditoria } = require('./audit-log');
const { registrarRotasDevolucoes } = require('./devolucoes-routes');
const { registrarRotasCrm } = require('./crm-routes');
const { registrarRotasGerencial } = require('./gerencial-routes');
const { registrarRotasConciliacao } = require('./conciliacao-routes');
const { registrarRotasComissoes } = require('./comissoes-routes');
const { registrarRotasContratos } = require('./contratos-routes');
const { registrarRotasOS } = require('./os-routes');
const { registrarRotasComm } = require('./comm-routes');
const { registrarRotasMDFe } = require('./mdfe-routes');
const { registrarRotasRH } = require('./rh-routes');
const { registrarRotasPatrimonio } = require('./patrimonio-routes');
const { registrarRotasRoteirizacao } = require('./roteirizacao-routes');
const { registrarRotasCTe } = require('./cte-routes');
const { registrarRotasMarketplaces } = require('./marketplaces-routes');
const { registrarRotasTEF } = require('./tef-routes');
const { registrarRotasMonitorV2, inicializarMonitorV2, getMonitor } = require('./monitor-v2-routes');
const { registrarRotasLicitacoes } = require('./licitacoes-routes');
const { createMonitorMensagens } = require('./monitor-mensagens-core');
const { registrarRotasGovBr } = require('./govbr-routes');
const { registrarRotasMonitorMensagens } = require('./monitor-mensagens-routes');
const { registrarRotasSniper, getSniper, getPuppeteerSession } = require('./sniper-lance-routes');
const { registrarRotasNfse, iniciarReconciliadorS6 } = require('./nfse-routes');
const { registrarRotasFinanceiro, agendarPollingBoletos } = require('./financeiro-routes');
const { registrarRotasRecorrencia } = require('./recorrencia-routes');
const { registrarRotasProdutos } = require('./produtos-routes');
const { registrarRotasEstoque } = require('./estoque-routes');
const { registrarRotasLotes } = require('./lotes-routes');
const { registrarRotasSerial } = require('./serial-routes');
const { registrarRotasReservas } = require('./reservas-routes');
const { registrarRotasInventario } = require('./inventario-routes');
const { registrarRotasPedidosCompra } = require('./pedidos-compra-routes');
const { registrarRotasPedidos } = require('./pedidos-routes');
const { registrarRotasFaturas } = require('./faturas-routes');
const { registrarRotasContasFinanceiras } = require('./contas-financeiras-routes');
const { registrarRotasNfeEmit } = require('./nfe-emit-routes');
const { registrarRotasNfeEntrada } = require('./nfe-entrada-routes');
const { registrarRotasContasPagar } = require('./contas-pagar-routes');
const { registrarRotasContasReceber } = require('./contas-receber-routes');
const { registrarRotasFluxoCaixa } = require('./fluxo-caixa-routes');
const { registrarRotasFiscalSN } = require('./fiscal-sn-routes');
const { registrarRotasLivroCaixa } = require('./livro-caixa-routes');
const { registrarRotasFiscalArquivamento } = require('./fiscal-arquivamento-routes');
const { registrarRotasRetencoes } = require('./retencoes-routes');
const { registrarRotasDefis } = require('./defis-routes');
const { registrarRotasNFCe } = require('./nfce-routes');
const { registrarRotasImportacao } = require('./importacao-routes');
const { registrarRotasCFOPs } = require('./cfops-routes');
const { agendarRecorrencias } = require('./recorrencia-scheduler');
const { registrarRotasCobrancas } = require('./cobrancas-routes');
const { registrarRotasBi } = require('./bi-routes');
const { registrarRotasPropostasParticipacoes } = require('./propostas-participacoes-routes');
const { registrarRotasGruposPalavras } = require('./grupos-palavras-routes');
const { registrarRotasBackup } = require('./backup-routes');
const { registrarRotasAnaliseIa } = require('./analise-ia-routes');
const { registrarRotasJornal } = require('./jornal-routes');
const { registrarRotasCertificado } = require('./certificado-routes');
const { registrarRotasProxy } = require('./proxy-routes');
const { registrarRotasFornecedor } = require('./fornecedor-routes');
const { registrarRotasTelegram } = require('./telegram-routes');
const { registrarRotasLances } = require('./lances-routes');
const { registrarRotasCredenciais } = require('./credenciais-routes');
const { registrarRotasRobo } = require('./robo-routes');
const { registrarRotasTracking } = require('./tracking-routes');
const { registrarRotasProposta } = require('./proposta-routes');
const { registrarRotasSync } = require('./sync-routes');
const { registrarRotasPdf } = require('./pdf-routes');
const { registrarRotasAdmin } = require('./admin-routes');
const { registrarRotasChatLeitura } = require('./chat-leitura-routes');
const { registrarRotasExtensoes } = require('./extensoes-routes');
const { registrarRotasExtensaoChrome } = require('./extensao-chrome-routes');
const { registrarRotasChatMonitoramento } = require('./chat-monitoramento-routes');
const { registrarRotasChatMensagens } = require('./chat-mensagens-routes');
const { registrarRotasParticipacaoMonitoramento } = require('./participacao-monitoramento-routes');
const { agendarCobrancas } = require('./cobranca-scheduler');
const { agendarJornal } = require('./jornal-scheduler');
const { registrarRotasWhatsApp } = require('./whatsapp-adapter');
const comprasnetLoginRoutes = require('./comprasnet-login-routes');

const app = express();

const PORT = 3000;

// Middleware
// SEC-05 (2026-04-18): CORS com origem explícita e body limit sensato.
// Chrome extension (chrome-extension://*) continua permitida; Electron e servidor
// interno usam apiKey e não passam pelo navegador.
const _corsAllow = (origin, cb) => {
  if (!origin) return cb(null, true); // curl, Electron, scripts — sem Origin
  if (/^chrome-extension:\/\//.test(origin)) return cb(null, true);
  if (/(^https?:\/\/localhost(:\d+)?$)/.test(origin)) return cb(null, true);
  if (/^https?:\/\/(app\.)?liciteagora\.com\.br(:\d+)?$/.test(origin)) return cb(null, true);
  if (/^https?:\/\/server\.votoaqui\.com\.br(:\d+)?$/.test(origin)) return cb(null, true);
  // Origem desconhecida: NÃO envia headers CORS — navegador bloqueia naturalmente,
  // clientes sem Origin (curl/Electron) não são afetados. Evita 500 visível.
  return cb(null, false);
};
app.use(cors({ origin: _corsAllow, credentials: true }));
// Limite geral 10MB (antes 50mb); rotas de upload de XML/PFX usam esta faixa. Multer
// nos uploads multipart tem limites próprios.
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

// Login page (público, antes do auth)
app.use(express.static(path.join(__dirname, 'public', 'auth')));

// Configuração da API do PNCP
const PNCP_API_BASE = 'https://pncp.gov.br/api/consulta/v1';
const PNCP_API_ITENS = 'https://pncp.gov.br/api/pncp/v1';

// Módulo de análise IA
const { analisarLicitacao, processarFilaAnalise } = require('./analise-ia');

// Banco de dados SQLite
const dbPath = path.join(__dirname, 'pncp.db');

const db = new Database(dbPath);

// Criar tabelas
db.exec(`
  CREATE TABLE IF NOT EXISTS licitacoes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    numeroControlePNCP TEXT UNIQUE,
    cnpj TEXT,
    razaoSocial TEXT,
    ufSigla TEXT,
    municipioNome TEXT,
    nomeUnidade TEXT,
    codigoUnidade TEXT,
    anoCompra INTEGER,
    sequencialCompra INTEGER,
    numeroCompra TEXT,
    processo TEXT,
    modalidadeId INTEGER,
    modalidadeNome TEXT,
    objetoCompra TEXT,
    informacaoComplementar TEXT,
    valorTotalEstimado REAL,
    dataPublicacaoPncp TEXT,
    dataAberturaProposta TEXT,
    dataEncerramentoProposta TEXT,
    situacaoCompraNome TEXT,
    linkSistemaOrigem TEXT,
    srp INTEGER,
    usuarioNome TEXT,
    dadosCompletos TEXT,
    dataAtualizacao TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS itens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    licitacaoId INTEGER,
    numeroControlePNCP TEXT,
    numeroItem INTEGER,
    descricao TEXT,
    quantidade REAL,
    unidadeMedida TEXT,
    valorUnitarioEstimado REAL,
    valorTotal REAL,
    dadosCompletos TEXT,
    FOREIGN KEY (licitacaoId) REFERENCES licitacoes(id)
  );

  CREATE TABLE IF NOT EXISTS config (
    chave TEXT PRIMARY KEY,
    valor TEXT,
    dataAtualizacao TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS resultados_bi (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cnpj TEXT NOT NULL,
    ano INTEGER NOT NULL,
    sequencial INTEGER NOT NULL,
    numeroItem INTEGER NOT NULL,
    niFornecedor TEXT,
    nomeRazaoSocialFornecedor TEXT,
    valorUnitarioHomologado REAL,
    valorTotalHomologado REAL,
    marcaFabricante TEXT,
    modeloVersao TEXT,
    dataResultado TEXT,
    dadosCompletos TEXT,
    dataCache TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(cnpj, ano, sequencial, numeroItem, niFornecedor)
  );

  CREATE INDEX IF NOT EXISTS idx_resultados_bi_item ON resultados_bi(cnpj, ano, sequencial, numeroItem);

  CREATE INDEX IF NOT EXISTS idx_licitacoes_encerramento ON licitacoes(dataEncerramentoProposta);
  CREATE INDEX IF NOT EXISTS idx_licitacoes_publicacao ON licitacoes(dataPublicacaoPncp);
  CREATE INDEX IF NOT EXISTS idx_licitacoes_modalidade ON licitacoes(modalidadeId);
  CREATE INDEX IF NOT EXISTS idx_licitacoes_cnpj ON licitacoes(cnpj);
  CREATE INDEX IF NOT EXISTS idx_itens_licitacao ON itens(licitacaoId);
  CREATE INDEX IF NOT EXISTS idx_itens_numero ON itens(numeroControlePNCP);
  CREATE INDEX IF NOT EXISTS idx_itens_descricao ON itens(descricao);

  CREATE TABLE IF NOT EXISTS interesse (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cnpj TEXT,
    ano INTEGER,
    sequencial INTEGER,
    numeroItem INTEGER,
    dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(cnpj, ano, sequencial, numeroItem)
  );

  CREATE INDEX IF NOT EXISTS idx_interesse_licitacao ON interesse(cnpj, ano, sequencial);

  CREATE TABLE IF NOT EXISTS interesse_compra_id (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cnpj TEXT NOT NULL,
    ano INTEGER NOT NULL,
    sequencial INTEGER NOT NULL,
    compraId TEXT NOT NULL,
    verificado INTEGER DEFAULT 0,
    dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(cnpj, ano, sequencial)
  );

  CREATE TABLE IF NOT EXISTS kanban_status (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cnpj TEXT,
    ano INTEGER,
    sequencial INTEGER,
    status TEXT DEFAULT 'analise',
    observacao TEXT,
    dataAtualizacao TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(cnpj, ano, sequencial)
  );

  CREATE TABLE IF NOT EXISTS licitacao_lida (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cnpj TEXT NOT NULL,
      ano INTEGER NOT NULL,
      sequencial INTEGER NOT NULL,
      dataLeitura TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(cnpj, ano, sequencial)
    );

  CREATE INDEX IF NOT EXISTS idx_lida_licitacao ON licitacao_lida(cnpj, ano, sequencial);

  CREATE TABLE IF NOT EXISTS sem_interesse (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cnpj TEXT NOT NULL,
    ano INTEGER NOT NULL,
    sequencial INTEGER NOT NULL,
    motivo TEXT,
    dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(cnpj, ano, sequencial)
  );

  CREATE INDEX IF NOT EXISTS idx_sem_interesse ON sem_interesse(cnpj, ano, sequencial);

  -- Tabela para configuração de lances do robô
  CREATE TABLE IF NOT EXISTS config_lances (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cnpj TEXT NOT NULL,
    ano INTEGER NOT NULL,
    sequencial INTEGER NOT NULL,
    numeroItem INTEGER NOT NULL,
    ativo INTEGER DEFAULT 1,
    precoMinimo REAL,
    descontoPercentual REAL,
    descontoFixo REAL,
    tipoDesconto TEXT DEFAULT 'percentual',
    horaExataTermino TEXT,
    tempoAntecedencia INTEGER DEFAULT 5,
    observacao TEXT,
    dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
    dataAtualizacao TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(cnpj, ano, sequencial, numeroItem)
  );

  CREATE INDEX IF NOT EXISTS idx_config_lances ON config_lances(cnpj, ano, sequencial);

  -- Tabela para sessões do robô
  CREATE TABLE IF NOT EXISTS robo_sessoes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cnpj TEXT NOT NULL,
    ano INTEGER NOT NULL,
    sequencial INTEGER NOT NULL,
    status TEXT DEFAULT 'aguardando',
    cookiesJson TEXT,
    ultimaAtividade TEXT,
    logExecucao TEXT,
    dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP
  );

  -- Tabela para dados do fornecedor
  CREATE TABLE IF NOT EXISTS fornecedor (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    razaoSocial TEXT,
    nomeFantasia TEXT,
    cnpj TEXT,
    inscricaoEstadual TEXT,
    inscricaoMunicipal TEXT,
    endereco TEXT,
    numero TEXT,
    complemento TEXT,
    bairro TEXT,
    cidade TEXT,
    uf TEXT,
    cep TEXT,
    telefone TEXT,
    celular TEXT,
    email TEXT,
    site TEXT,
    representanteLegal TEXT,
    cpfRepresentante TEXT,
    cargoRepresentante TEXT,
    banco TEXT,
    agencia TEXT,
    conta TEXT,
    tipoConta TEXT,
    logoBase64 TEXT,
    observacoes TEXT,
    declaracaoMeEpp INTEGER DEFAULT 1,
    declaracaoProgramasIntegridade INTEGER DEFAULT 0,
    declaracaoEquidadeGenero INTEGER DEFAULT 0,
    dataAtualizacao TEXT DEFAULT CURRENT_TIMESTAMP
  );

  -- Tabela para certificado digital
  CREATE TABLE IF NOT EXISTS certificado_digital (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    certificadoBase64 TEXT,
    senhaCriptografada TEXT,
    titular TEXT,
    validade TEXT,
    dataAtualizacao TEXT DEFAULT CURRENT_TIMESTAMP
  );

  -- Tabela para valores de proposta (persistência)
  CREATE TABLE IF NOT EXISTS valores_proposta (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cnpj TEXT NOT NULL,
    ano INTEGER NOT NULL,
    sequencial INTEGER NOT NULL,
    numeroItem INTEGER NOT NULL,
    valorUnitario REAL,
    marca TEXT,
    modelo TEXT,
    fabricante TEXT,
    selecionado INTEGER DEFAULT 0,
    dataAtualizacao TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(cnpj, ano, sequencial, numeroItem)
  );

  CREATE INDEX IF NOT EXISTS idx_valores_proposta ON valores_proposta(cnpj, ano, sequencial);

  -- Tabela para configuração do Telegram
  CREATE TABLE IF NOT EXISTS telegram_config (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    botToken TEXT,
    chatId TEXT,
    ativo INTEGER DEFAULT 1,
    dataAtualizacao TEXT DEFAULT CURRENT_TIMESTAMP
  );

  -- Tabela para alertas enviados (evitar duplicatas)
  CREATE TABLE IF NOT EXISTS alertas_enviados (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tipo TEXT NOT NULL,
    referencia TEXT NOT NULL,
    dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(tipo, referencia)
  );

  -- Tabela para monitoramento de chat do Comprasnet
  CREATE TABLE IF NOT EXISTS chat_monitoramento (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cnpj TEXT NOT NULL,
    ano INTEGER NOT NULL,
    sequencial INTEGER NOT NULL,
    ativo INTEGER DEFAULT 1,
    ultimaMensagemId TEXT,
    dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(cnpj, ano, sequencial)
  );

  -- Tabela para rastrear última mensagem verificada de cada licitação (otimização)
  CREATE TABLE IF NOT EXISTS chat_ultima_verificacao (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chave TEXT NOT NULL UNIQUE,
    ultimaDataHoraMensagem TEXT,
    ultimoHashMensagem TEXT,
    totalMensagens INTEGER DEFAULT 0,
    dataVerificacao TEXT DEFAULT CURRENT_TIMESTAMP
  );

  -- Tabela para palavras-chave de alerta no chat
  CREATE TABLE IF NOT EXISTS chat_palavras_chave (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    palavra TEXT NOT NULL UNIQUE,
    ativo INTEGER DEFAULT 1,
    dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP
  );

  -- Tabela para licitações a monitorar (chat) - DEPRECADA, usar participacoes_comprasnet
  CREATE TABLE IF NOT EXISTS licitacoes_monitorar (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cnpjOrgao TEXT NOT NULL,
    ano INTEGER NOT NULL,
    sequencial INTEGER NOT NULL,
    descricao TEXT,
    urlCompra TEXT,
    ativo INTEGER DEFAULT 1,
    dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(cnpjOrgao, ano, sequencial)
  );

  -- Tabela para participações do Comprasnet (sincronizado automaticamente pela extensão)
  CREATE TABLE IF NOT EXISTS participacoes_comprasnet (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    compraId TEXT NOT NULL UNIQUE,
    cnpj TEXT NOT NULL,
    codigoUnidade TEXT,
    ano INTEGER NOT NULL,
    sequencial INTEGER NOT NULL,
    tipo TEXT,
    numero TEXT,
    orgao TEXT,
    objeto TEXT,
    etapa TEXT,
    situacao TEXT,
    urlCompra TEXT,
    dataSessao TEXT,
    ativo INTEGER DEFAULT 1,
    dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
    dataAtualizacao TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_participacoes_cnpj ON participacoes_comprasnet(cnpj, ano, sequencial);
  CREATE INDEX IF NOT EXISTS idx_participacoes_ativo ON participacoes_comprasnet(ativo);

  -- Tabela para mensagens do chat (cópia local)
  -- Tabela persistente (não dropar!)
  CREATE TABLE IF NOT EXISTS chat_mensagens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cnpjOrgao TEXT NOT NULL,
    ano INTEGER NOT NULL,
    sequencial INTEGER NOT NULL,
    remetente TEXT,
    mensagem TEXT NOT NULL,
    dataHoraMensagem TEXT,
    hashMensagem TEXT UNIQUE,
    temCnpjFornecedor INTEGER DEFAULT 0,
    palavrasChaveEncontradas TEXT,
    notificado INTEGER DEFAULT 0,
    dataCaptura TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_chat_mensagens_licitacao ON chat_mensagens(cnpjOrgao, ano, sequencial);
  CREATE INDEX IF NOT EXISTS idx_chat_mensagens_hash ON chat_mensagens(hashMensagem);
  CREATE INDEX IF NOT EXISTS idx_chat_mensagens_data ON chat_mensagens(dataHoraMensagem DESC);
  CREATE INDEX IF NOT EXISTS idx_chat_mensagens_compra ON chat_mensagens(compraId);

  -- Tabela para checkpoint/progresso de captura de cada licitação
  CREATE TABLE IF NOT EXISTS chat_captura_progresso (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    compraId TEXT NOT NULL UNIQUE,
    cnpjOrgao TEXT,
    ano INTEGER,
    sequencial INTEGER,
    ultimaPaginaCapturada INTEGER DEFAULT 0,
    totalPaginasEncontradas INTEGER DEFAULT 0,
    totalMensagensCapturadas INTEGER DEFAULT 0,
    capturaCompleta INTEGER DEFAULT 0,
    ultimaCaptura TEXT DEFAULT CURRENT_TIMESTAMP,
    dataAtualizacao TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_chat_progresso_compra ON chat_captura_progresso(compraId);

  -- Tabela para sessão de monitoramento (salvar/restaurar posição)
  CREATE TABLE IF NOT EXISTS monitoramento_sessao (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    statusAtual TEXT,
    paginaAtual INTEGER DEFAULT 1,
    indiceLicitacao INTEGER DEFAULT 0,
    totalLicitacoes INTEGER DEFAULT 0,
    licitacoesProcessadas TEXT DEFAULT '[]',
    ativo INTEGER DEFAULT 1,
    dataInicio TEXT DEFAULT CURRENT_TIMESTAMP,
    dataAtualizacao TEXT DEFAULT CURRENT_TIMESTAMP
  );

  -- Tabela de grupos de palavras-chave para pesquisa e exclusão
  CREATE TABLE IF NOT EXISTS grupos_palavras (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL,
    descricao TEXT,
    cor TEXT DEFAULT '#1a5f7a',
    tipo TEXT DEFAULT 'pesquisa',
    ativo INTEGER DEFAULT 1,
    dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
    dataAtualizacao TEXT DEFAULT CURRENT_TIMESTAMP
  );

  -- Tabela de palavras de cada grupo
  CREATE TABLE IF NOT EXISTS grupos_palavras_itens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    grupoId INTEGER NOT NULL,
    palavra TEXT NOT NULL,
    FOREIGN KEY (grupoId) REFERENCES grupos_palavras(id) ON DELETE CASCADE,
    UNIQUE(grupoId, palavra)
  );

  -- Tabela de vínculo entre grupos de pesquisa e grupos de exclusão (N:N)
  CREATE TABLE IF NOT EXISTS grupos_pesquisa_exclusao (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    grupoPesquisaId INTEGER NOT NULL,
    grupoExclusaoId INTEGER NOT NULL,
    dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (grupoPesquisaId) REFERENCES grupos_palavras(id) ON DELETE CASCADE,
    FOREIGN KEY (grupoExclusaoId) REFERENCES grupos_palavras(id) ON DELETE CASCADE,
    UNIQUE(grupoPesquisaId, grupoExclusaoId)
  );

  -- Grupos de palavras são criados pelo usuário na interface

  -- Tabela de configuração do Jornal de Licitações
  CREATE TABLE IF NOT EXISTS jornal_config (
    id INTEGER PRIMARY KEY DEFAULT 1,
    ativo INTEGER DEFAULT 0,
    horario TEXT DEFAULT '08:00',
    diasAntecedencia INTEGER DEFAULT 7,
    enviarTelegram INTEGER DEFAULT 1,
    dataUltimoEnvio TEXT,
    dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP
  );

  -- Tabela de grupos ativos no jornal
  CREATE TABLE IF NOT EXISTS jornal_grupos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    grupoId INTEGER NOT NULL,
    ativo INTEGER DEFAULT 1,
    FOREIGN KEY (grupoId) REFERENCES grupos_palavras(id) ON DELETE CASCADE,
    UNIQUE(grupoId)
  );

  -- Histórico de envios do jornal
  CREATE TABLE IF NOT EXISTS jornal_historico (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dataEnvio TEXT DEFAULT CURRENT_TIMESTAMP,
    totalLicitacoes INTEGER DEFAULT 0,
    gruposProcessados TEXT,
    status TEXT DEFAULT 'sucesso',
    mensagem TEXT
  );

  -- Tabela de itens para o sniper de lances (configuração por item)
  CREATE TABLE IF NOT EXISTS sniper_itens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    compraId TEXT NOT NULL,
    itemNumero INTEGER NOT NULL,
    descricao TEXT,
    valorLance REAL,
    faseItem TEXT DEFAULT 'LA',
    horarioAlvo TEXT,
    antecedenciaMs INTEGER DEFAULT 3000,
    tentativas INTEGER DEFAULT 3,
    intervaloMs INTEGER DEFAULT 500,
    ativo INTEGER DEFAULT 1,
    status TEXT DEFAULT 'pendente',
    ultimoResultado TEXT,
    ultimoEnvio TEXT,
    dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
    dataAtualizacao TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(compraId, itemNumero)
  );
  CREATE INDEX IF NOT EXISTS idx_sniper_itens_compra ON sniper_itens(compraId);

  -- Histórico de lances enviados pelo sniper
  CREATE TABLE IF NOT EXISTS sniper_historico (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    compraId TEXT NOT NULL,
    itemNumero INTEGER NOT NULL,
    valor REAL NOT NULL,
    httpStatus INTEGER,
    sucesso INTEGER,
    tempoMs INTEGER,
    resposta TEXT,
    fonte TEXT DEFAULT 'browser',
    timestamp TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_sniper_hist_compra ON sniper_historico(compraId);
  -- SNIPER-M08: index composto para lookups por (compraId, itemNumero) ordenados por tempo
  CREATE INDEX IF NOT EXISTS idx_historico_compra_item_ts ON sniper_historico(compraId, itemNumero, timestamp);

  -- Histórico do estado do mercado (mudanças detectadas pelo guard mode)
  CREATE TABLE IF NOT EXISTS sniper_classificacao (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    compraId TEXT NOT NULL,
    itemNumero INTEGER NOT NULL,
    melhorGeral REAL,
    nossoValor REAL,
    situacao TEXT,
    fonte TEXT,
    timestamp TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_sniper_class_compra ON sniper_classificacao(compraId, itemNumero);

  -- Agendamentos de blitz persistidos (sobrevivem a restart do servidor)
  CREATE TABLE IF NOT EXISTS blitz_agendadas (
    blitzKey TEXT PRIMARY KEY,
    compraId TEXT NOT NULL,
    itemNumero INTEGER NOT NULL,
    horario TEXT NOT NULL,
    alvoMs INTEGER NOT NULL,
    maxLances INTEGER DEFAULT 50,
    modoBlitz TEXT DEFAULT 'cobrir',
    agendadoEm TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_blitz_alvo ON blitz_agendadas(alvoMs);

  CREATE TABLE IF NOT EXISTS licitacao_analise (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    numeroControlePNCP TEXT UNIQUE,
    cnpj TEXT,
    ano INTEGER,
    sequencial INTEGER,
    resumo TEXT,
    segmento TEXT,
    itens_destaque TEXT DEFAULT '[]',
    requisitos TEXT DEFAULT '[]',
    atencao TEXT DEFAULT '[]',
    prazo_entrega TEXT,
    local_entrega TEXT,
    criterio_julgamento TEXT,
    vistoria_obrigatoria INTEGER DEFAULT 0,
    exclusivo_mei_epp INTEGER DEFAULT 0,
    viabilidade_score INTEGER DEFAULT 50,
    viabilidade_justificativa TEXT,
    complexidade TEXT DEFAULT 'média',
    arquivos_info TEXT DEFAULT '[]',
    textos_extraidos INTEGER DEFAULT 0,
    dataAnalise TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_analise_pncp ON licitacao_analise(numeroControlePNCP);
  CREATE INDEX IF NOT EXISTS idx_analise_score ON licitacao_analise(viabilidade_score);

  -- Inserir configuração padrão do jornal
  INSERT OR IGNORE INTO jornal_config (id, ativo, horario) VALUES (1, 0, '08:00');

  -- Tabela de análises IA das licitações
  CREATE TABLE IF NOT EXISTS licitacao_analise (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    numeroControlePNCP TEXT UNIQUE,
    cnpj TEXT,
    ano INTEGER,
    sequencial INTEGER,
    resumo TEXT,
    segmento TEXT,
    itens_destaque TEXT DEFAULT '[]',
    requisitos TEXT DEFAULT '[]',
    atencao TEXT DEFAULT '[]',
    prazo_entrega TEXT,
    local_entrega TEXT,
    criterio_julgamento TEXT,
    vistoria_obrigatoria INTEGER DEFAULT 0,
    exclusivo_mei_epp INTEGER DEFAULT 0,
    viabilidade_score INTEGER DEFAULT 50,
    viabilidade_justificativa TEXT,
    complexidade TEXT DEFAULT 'média',
    arquivos_info TEXT DEFAULT '[]',
    textos_extraidos INTEGER DEFAULT 0,
    dataAnalise TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_analise_pncp ON licitacao_analise(numeroControlePNCP);
  CREATE INDEX IF NOT EXISTS idx_analise_score ON licitacao_analise(viabilidade_score);
`);

// Migração: adicionar coluna 'tipo' na tabela grupos_palavras se não existir
try {
  // Verificar se coluna existe
  const info = db.pragma('table_info(grupos_palavras)');
  const temTipo = info.some(col => col.name === 'tipo');

  if (!temTipo) {
    db.exec(`ALTER TABLE grupos_palavras ADD COLUMN tipo TEXT DEFAULT 'pesquisa'`);
    db.exec(`UPDATE grupos_palavras SET tipo = 'pesquisa' WHERE tipo IS NULL`);
    console.log('[Migração] Coluna "tipo" adicionada à tabela grupos_palavras');
  } else {
    console.log('[Migração] Coluna "tipo" já existe');

// Migração: adicionar coluna 'lido' na tabela chat_mensagens
try {
  const infoMsg = db.pragma('table_info(chat_mensagens)');
  const temLido = infoMsg.some(col => col.name === 'lido');
  if (!temLido) {
    db.exec(`ALTER TABLE chat_mensagens ADD COLUMN lido INTEGER DEFAULT 0`);
    db.exec(`ALTER TABLE chat_mensagens ADD COLUMN dataLeitura TEXT`);
    console.log('[Migração] Coluna "lido" adicionada à tabela chat_mensagens');
  }
} catch (e) {
  // Ignora se já existe
}
  }
} catch (e) {
  console.log('[Migração] Erro:', e.message);
}

// Migração: adicionar colunas para sync de mensagens via API v1 global
try {
  const infoMsg2 = db.pragma('table_info(chat_mensagens)');
  const colsMsg = infoMsg2.map(c => c.name);
  const novasCols = [
    ['mensagemIdComprasnet', 'INTEGER'],
    ['titulo', 'TEXT'],
    ['origemMensagem', 'TEXT'],
    ['lidaComprasnet', 'INTEGER DEFAULT 0'],
    ['tipoCompra', 'TEXT'],
    ['excluida', 'INTEGER DEFAULT 0'],
    ['vinculadaADiligencia', 'INTEGER DEFAULT 0'],
    ['descricaoModalidade', 'TEXT'],
    ['numeroCompraFormatado', 'TEXT'],
    ['origemCaptura', "TEXT DEFAULT 'servidor'"],
  ];
  for (const [nome, tipo] of novasCols) {
    if (!colsMsg.includes(nome)) {
      db.exec(`ALTER TABLE chat_mensagens ADD COLUMN ${nome} ${tipo}`);
      console.log(`[Migração] Coluna "${nome}" adicionada à chat_mensagens`);
    }
  }
  // Índice para dedup por ID do Comprasnet
  try {
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_mensagens_comprasnet_id ON chat_mensagens(mensagemIdComprasnet) WHERE mensagemIdComprasnet IS NOT NULL`);
  } catch (e) {}
} catch (e) {
  console.log('[Migração] Erro colunas mensagens v1:', e.message);
}

// Migração: adicionar colunas de config ao sniper_itens
try {
  const infoSniper = db.pragma('table_info(sniper_itens)');
  if (infoSniper.length > 0) {
    const cols = infoSniper.map(c => c.name);
    if (!cols.includes('valorMinimo')) {
      db.exec(`ALTER TABLE sniper_itens ADD COLUMN valorMinimo REAL`);
      console.log('[Migração] sniper_itens: valorMinimo adicionado');
    }
    if (!cols.includes('descontoMinimo')) {
      db.exec(`ALTER TABLE sniper_itens ADD COLUMN descontoMinimo REAL`);
      console.log('[Migração] sniper_itens: descontoMinimo adicionado');
    }
    if (!cols.includes('descontoMaximo')) {
      db.exec(`ALTER TABLE sniper_itens ADD COLUMN descontoMaximo REAL`);
      console.log('[Migração] sniper_itens: descontoMaximo adicionado');
    }
    if (!cols.includes('valorEstimado')) {
      db.exec(`ALTER TABLE sniper_itens ADD COLUMN valorEstimado REAL`);
      console.log('[Migração] sniper_itens: valorEstimado adicionado');
    }
    if (!cols.includes('modoAuto')) {
      db.exec(`ALTER TABLE sniper_itens ADD COLUMN modoAuto TEXT`);
      console.log('[Migração] sniper_itens: modoAuto adicionado');
    }
  }
} catch (e) {
  console.log('[Migração sniper_itens] Erro:', e.message);
}

// NFSE-M06 onda 5C: persistência de licitacao/itens extraída para
// licitacoes-persistence.js (consumida pelo motor PNCP no
// pncp-sync-scheduler.js, pela rota POST /sync-itens aqui, e pelo
// verificador de lacunas). Statements ficam no módulo, factory prepara
// uma vez por processo.
const { createPersistence } = require('./licitacoes-persistence');
const { salvarLicitacao, salvarItens } = createPersistence(db);

// NFSE-M06 onda 5C passo 2 (2026-04-20): motor PNCP + schedulers master-only
// (sincronizarCompleta/Incremental, watchdog, alertas de disputa, verificação
// diária de lacunas) extraídos para pncp-sync-scheduler.js.
// No master (scheduler.js na onda 5C passo 4) chama-se iniciarSyncEngine()
// + startMasterOnlyTimers(). No worker o módulo é carregado apenas para
// atender GET /api/sync/status via pncpSync.getSyncStatus() e as rotas
// POST /api/sync/* respondem 503 — sync manual tem que sair do master.
const pncpSync = require('./pncp-sync-scheduler');
pncpSync.init({ db, processarFilaAnalise });

const getConfig = db.prepare(`SELECT valor FROM config WHERE chave = ?`);
const setConfig = db.prepare(`INSERT OR REPLACE INTO config (chave, valor, dataAtualizacao) VALUES (?, ?, CURRENT_TIMESTAMP)`);

/**
 * Funções de configuração — mantidas em server.js por terem ~37 call-sites
 * espalhados pelo arquivo. O motor PNCP em pncp-sync-scheduler.js tem cópia
 * interna própria (não compartilhada).
 */
function getConfigValue(chave) {
  const row = getConfig.get(chave);
  return row ? row.valor : null;
}

function setConfigValue(chave, valor) {
  setConfig.run(chave, valor);
}

/**
 * NFSE-M06 onda 5C passo 2: getIAKeys mantida em server.js porque rotas HTTP
 * `/api/licitacoes/:cnpj/:ano/:sequencial/analisar` e `/api/analise/processar`
 * (que rodam no worker, não no master) dependem dela. O pncp-sync-scheduler
 * tem uma cópia interna privada — são funções triviais (2 lookups em config),
 * não vale uma abstração compartilhada.
 */
function getIAKeys() {
  const gemini = getConfigValue('gemini_api_key');
  const anthropic = getConfigValue('anthropic_api_key');
  if (!gemini && !anthropic) return null;
  return { gemini: gemini || null, anthropic: anthropic || null };
}

// NFSE-M06 onda 5C passo 2 (2026-04-20): gerarDiasEntre, buscarLicitacoesDoDia,
// buscarItensLicitacao, getIAKeys, dispararAnaliseIA, sincronizarCompleta,
// sincronizarIncremental, agendarProximaSync e iniciarWatchdogSync foram
// integralmente movidos para pncp-sync-scheduler.js. Consulte aquele módulo.


// ==================== AUTENTICAÇÃO ====================
criarUsuarioInicial(db);
const sessionSecret = getSessionSecret(db);
const apiKey = getApiKey(db);

// Session middleware (antes de tudo que precisa de sessão)
app.use(session({
  store: createSessionStore(session, db),
  secret: sessionSecret,
  name: 'liciteagora.sid',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000, httpOnly: true, sameSite: 'lax', secure: false }
}));

// Login (público) — SEC-03 (2026-04-18): rate limit por IP + mensagem uniforme
// anti-enumeração. 5 tentativas falhas em 15 min → 429 por mais 15 min.
const _loginAttempts = new Map(); // ip → { fails, firstAt, blockedUntil }
const LOGIN_MAX_FAILS = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_BLOCK_MS = 15 * 60 * 1000;
setInterval(() => {
  const agora = Date.now();
  for (const [ip, st] of _loginAttempts) {
    if ((st.blockedUntil && st.blockedUntil < agora) || (agora - st.firstAt) > LOGIN_WINDOW_MS) {
      _loginAttempts.delete(ip);
    }
  }
}, 5 * 60 * 1000).unref();

function _loginClientIp(req) {
  const fwd = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || req.ip || req.socket?.remoteAddress || 'unknown';
}

app.post('/api/login', (req, res) => {
  const ip = _loginClientIp(req);
  const agora = Date.now();
  const st = _loginAttempts.get(ip);
  if (st && st.blockedUntil && st.blockedUntil > agora) {
    const retryIn = Math.ceil((st.blockedUntil - agora) / 1000);
    res.set('Retry-After', String(retryIn));
    return res.status(429).json({ success: false, error: 'Muitas tentativas. Tente novamente em alguns minutos.' });
  }

  const { username, password } = req.body;
  if (!username || !password) return res.json({ success: false, error: 'Informe usuário e senha' });

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  const senhaOk = !!user && bcrypt.compareSync(password, user.passwordHash);
  // Mensagem uniforme — não diferencia usuário inexistente, senha errada ou inativo.
  if (!senhaOk || !user || user.ativo === 0) {
    const cur = _loginAttempts.get(ip) || { fails: 0, firstAt: agora, blockedUntil: 0 };
    if ((agora - cur.firstAt) > LOGIN_WINDOW_MS) { cur.fails = 0; cur.firstAt = agora; }
    cur.fails += 1;
    if (cur.fails >= LOGIN_MAX_FAILS) cur.blockedUntil = agora + LOGIN_BLOCK_MS;
    _loginAttempts.set(ip, cur);
    // Auditoria de tentativas falhas (best-effort)
    try {
      db.prepare(`INSERT INTO audit_log (username, action, entity, payload, ip) VALUES (?, 'login_fail', 'auth', ?, ?)`)
        .run(String(username).slice(0, 120), JSON.stringify({ reason: !user ? 'no_user' : (user.ativo === 0 ? 'inactive' : 'bad_password') }), ip);
    } catch { /* tabela pode não existir ainda em migração */ }
    return res.status(401).json({ success: false, error: 'Usuário ou senha incorretos' });
  }

  _loginAttempts.delete(ip); // sucesso limpa contador
  db.prepare('UPDATE users SET ultimoLogin = CURRENT_TIMESTAMP WHERE id = ?').run(user.id);
  req.session.userId = user.id;
  req.session.username = user.username;
  res.json({ success: true, username: user.username, nome: user.nome, role: user.role });
});

// Logout (público)
app.post('/api/logout', (req, res) => {
  if (req.session) {
    req.session.destroy(() => {
      res.clearCookie('liciteagora.sid');
      res.json({ success: true });
    });
  } else {
    res.json({ success: true });
  }
});

// ==================== PORTAL DO CLIENTE (antes do auth) ====================
app.use('/portal', express.static(path.join(__dirname, 'public', 'portal')));
const { registrarRotasPortal, registrarRotasPortalAdmin } = require('./portal-routes');
registrarRotasPortal(app, db);

// ==================== DOWNLOAD PÚBLICO (antes do auth) ====================
app.get('/download/:file', (req, res) => {
  const allowed = ['LiciteAgora-Browser-win.zip'];
  if (!allowed.includes(req.params.file)) return res.status(404).end();
  const filePath = path.join(__dirname, 'electron-standalone', 'dist', req.params.file);
  if (!require('fs').existsSync(filePath)) return res.status(404).json({ error: 'Arquivo não encontrado' });
  res.download(filePath);
});

// ==================== COMPRASNET AUTO-LOGIN (Público - antes do auth) ====================
app.use('/api/comprasnet', comprasnetLoginRoutes);
// ==================== ELECTRON REMOTO (antes do auth) ====================
const { registrarRotasElectron } = require('./electron-routes');
registrarRotasElectron(app, db, { apiKey });

// Auth barrier — tudo abaixo requer autenticação (exceto webhook e X-Api-Key)
app.use(requireAuth(apiKey, db));

// Alterar senha (protegido)
app.post('/api/change-password', (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Informe senha atual e nova' });
  if (newPassword.length < 8) return res.status(400).json({ error: 'Senha deve ter pelo menos 8 caracteres' });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  if (!user || !bcrypt.compareSync(currentPassword, user.passwordHash)) {
    return res.status(400).json({ error: 'Senha atual incorreta' });
  }
  const hash = bcrypt.hashSync(newPassword, 10);
  db.prepare('UPDATE users SET passwordHash = ? WHERE id = ?').run(hash, user.id);
  res.json({ success: true });
});

// API key para extensão (protegido)
app.get('/api/auth/api-key', (req, res) => {
  res.json({ apiKey });
});

// Arquivos estáticos protegidos (APÓS rotas de API para que não intercepte)
app.use(express.static(path.join(__dirname, 'public')));

// NFSE-M06 onda 6.29 (2026-04-20): 5 rotas do catálogo PNCP migradas
// para licitacoes-routes.js (GET /api/licitacoes, /orgaos, detalhes,
// itens e POST sync-itens pontual).
registrarRotasLicitacoes(app, db, { pncpSync, salvarItens, PNCP_API_BASE, PNCP_API_ITENS });

// ==================== CERTIFICADO DIGITAL — extraído ====================
// NFSE-M06 onda 6.7 (2026-04-20): 3 rotas (status/save/delete) migradas
// para certificado-routes.js.

// ==================== TELEGRAM / ALERTAS ====================

// Função para enviar mensagem no Telegram (HTML)
// NFSE-M06 onda 5C: corpo extraído para telegram-client.js para que o
// scheduler.js (processo master sem Express) possa usar a mesma lógica
// sem require server.js. Callers aqui continuam chamando enviarTelegram(msg).
const { sendTelegram: _sendTelegramViaClient, sendNotificacao: _sendNotificacaoViaClient } = require('./telegram-client');
async function enviarTelegram(mensagem) {
  return _sendTelegramViaClient(db, mensagem);
}

// Função para enviar notificação formatada do chat de licitação
// NFSE-M06 onda 6.30 (2026-04-20): corpo migrado para telegram-client.js
// (sendNotificacao). Mantemos o wrapper local para não mexer no opts
// passado para registrarRotasExtensaoChrome.
async function enviarNotificacaoTelegram(dados) {
  return _sendNotificacaoViaClient(db, dados);
}

// ==================== ALERTA DISPUTA (Telegram 30 min antes) ====================
// NFSE-M06 onda 5C passo 2: verificarAlertasDisputa + timer (setInterval 5min
// e setTimeout 30s pós-boot) migraram para pncp-sync-scheduler.js. O master
// liga tudo via pncpSync.startMasterOnlyTimers(). No worker não roda — o gate
// ROLE=master que existia aqui desde a onda 5B deixa de ser necessário porque
// o módulo só dispara os timers quando o master explicitamente solicita.

// ==================== MONITOR V2 (API direta Comprasnet) ====================
registrarRotasMonitorV2(app, db, {
  enviarTelegram: enviarTelegram,
  getConfigValue: getConfigValue,
  intervaloMinutos: 3,
});

// ==================== SNIPER DE LANCES ====================
registrarRotasSniper(app, getMonitor, db);

// ==================== NFSE NACIONAL ====================
registrarRotasNfse(app, db);

// ==================== COBRANCAS + WHATSAPP ====================
registrarRotasCobrancas(app, db);
registrarRotasWhatsApp(app, db);

// ==================== FINANCEIRO (Pessoas, Contas a Receber, Boletos, MercadoPago) ====================
registrarRotasFinanceiro(app, db);

// ==================== RECORRENCIAS NFSE ====================
registrarRotasRecorrencia(app, db);

// ==================== SUPRIMENTOS (Produtos, Estoque, Pedidos) ====================
registrarRotasProdutos(app, db);
registrarRotasEstoque(app, db);
registrarRotasLotes(app, db);
registrarRotasSerial(app, db);
registrarRotasReservas(app, db);
registrarRotasInventario(app, db);
registrarRotasPedidosCompra(app, db);
registrarRotasPedidos(app, db);
registrarRotasContasFinanceiras(app, db);
registrarRotasFaturas(app, db);
registrarRotasNfeEmit(app, db);
registrarRotasNfeEntrada(app, db);
registrarRotasContasPagar(app, db);
registrarRotasContasReceber(app, db);
registrarRotasFluxoCaixa(app, db);
registrarRotasFiscalSN(app, db);
registrarRotasLivroCaixa(app, db);
registrarRotasFiscalArquivamento(app, db);
registrarRotasRetencoes(app, db);
registrarRotasDefis(app, db);
registrarRotasNFCe(app, db);
registrarRotasImportacao(app, db);
registrarRotasCFOPs(app, db);
registrarRotasUsuarios(app, db);
registrarRotasAuditoria(app, db);
registrarRotasDevolucoes(app, db);
registrarRotasCrm(app, db);
registrarRotasGerencial(app, db);
registrarRotasConciliacao(app, db);
registrarRotasComissoes(app, db);
registrarRotasContratos(app, db);
registrarRotasPortalAdmin(app, db);
registrarRotasOS(app, db);
registrarRotasComm(app, db);
registrarRotasMDFe(app, db);
registrarRotasRH(app, db);
registrarRotasPatrimonio(app, db);
registrarRotasRoteirizacao(app, db);
registrarRotasCTe(app, db);
registrarRotasMarketplaces(app, db);
registrarRotasTEF(app, db);
registrarRotasBi(app, db);
registrarRotasPropostasParticipacoes(app, db);
registrarRotasGruposPalavras(app, db);
registrarRotasBackup(app, db, { dbPath, PORT });
registrarRotasAnaliseIa(app, db, { getConfigValue, setConfigValue, getIAKeys });
registrarRotasJornal(app, db);
registrarRotasCertificado(app, db);
registrarRotasProxy(app, db);
registrarRotasFornecedor(app, db);
registrarRotasTelegram(app, db, { enviarTelegram });
registrarRotasLances(app, db, { enviarTelegram });
registrarRotasCredenciais(app, db);
registrarRotasRobo(app, db);
registrarRotasTracking(app, db);
registrarRotasProposta(app, db);
registrarRotasSync(app, db, { pncpSync });
registrarRotasPdf(app, db);
registrarRotasAdmin(app, db, { getConfigValue, setConfigValue });
registrarRotasChatLeitura(app, db);
registrarRotasExtensoes(app, { getConfigValue });
// ==================== ROBÔ DE MONITORAMENTO DE MENSAGENS + CREDENCIAIS GOV.BR ====================
// NFSE-M06 onda 6.28 (2026-04-20): consolidação.
//  - classes MonitorMensagensComprasnet + MonitorChat vêm de monitor-mensagens-core.js (6.26)
//  - 4 rotas do robô (/iniciar, /parar, /status, /ativos) em monitor-mensagens-routes.js (6.27)
//  - 3 rotas gov.br (/api/govbr/*) + estado monitorMensagens em govbr-routes.js (6.28)
//  - extensao-chrome usa getMonitor exposto por govbr-routes
const { MonitorMensagensComprasnet, MonitorChat } = createMonitorMensagens({
  db, getConfigValue, enviarTelegram
});
const govbrApi = registrarRotasGovBr(app, db, { getConfigValue, setConfigValue, MonitorMensagensComprasnet });
registrarRotasMonitorMensagens(app, db, { MonitorChat });

registrarRotasExtensaoChrome(app, db, { getConfigValue, enviarNotificacaoTelegram, getMonitor: govbrApi.getMonitor });
registrarRotasChatMonitoramento(app, db);
registrarRotasChatMensagens(app, db);
registrarRotasParticipacaoMonitoramento(app, db, { enviarTelegram });


// NFSE-M06 onda 5C passo 2: o verificador de lacunas (verificarECorrigirLacunas
// e verificacaoCompletaDiaria) agora é criado dentro de pncp-sync-scheduler.js
// no init — ele era o único consumidor destas funções em server.js. A terceira
// função retornada (corrigirItensFaltantes) era desde sempre dead code aqui.
// A verificação diária às 03:00 + o watchdog de sync pararem de rodar no
// worker vieram da onda 5B; 5C apenas move a implementação para o módulo.

// PROPOSTAS (v1 /api/proposta/enviar + v2 via participações)
// Extraído em NFSE-M06 onda 6.2 para propostas-participacoes-routes.js.
// Factory registrado no topo junto a registrarRotasBi / registrarRotasTEF.


// GRUPOS DE PALAVRAS-CHAVE (pesquisa/exclusão) + rota /pesquisar
// Extraído em NFSE-M06 onda 6.3 para grupos-palavras-routes.js.
// Factory registrado no topo junto a registrarRotasPropostasParticipacoes.


// ==================== JORNAL DE LICITAÇÕES — extraído ====================
// NFSE-M06 onda 6.6 (2026-04-20): 5 rotas migradas para jornal-routes.js.
// agendarJornal() continua chamado pelo master via _iniciarSchedulersMaster.


// SISTEMA DE BACKUP E VERSIONAMENTO (backup SQLite + git tags)
// Extraído em NFSE-M06 onda 6.4 para backup-routes.js.
// Factory registrado no topo junto a registrarRotasGruposPalavras.

// ==================== ANÁLISE IA (rotas) — extraído ====================
// NFSE-M06 onda 6.5 (2026-04-20): 7 rotas migradas para analise-ia-routes.js.
// Factory registrarRotasAnaliseIa chamada no topo junto aos outros módulos.

// BI — registrado via bi-routes.js (NFSE-M06 onda 6.1, 2026-04-20).
// Bloco de ~291 linhas com 6 rotas (pesquisa local, resultados PNCP,
// Dados Abertos, pesquisa de preço) migrado para módulo dedicado.

// ─── ROTAS DE ANÁLISE IA (Bloco B) — extraído ──────────────────────────────
// NFSE-M06 onda 6.5 (2026-04-20): 6 rotas migradas para analise-ia-routes.js,
// registradas após o Bloco A (mesma ordem original) para preservar quem
// vence em /api/analise/stats e quem responde aos endpoints com ordem de
// parâmetros :cnpj/:sequencial/:ano.

// NFSE-M06 (2026-04-20): cada systemd unit tinha sua própria corrida para bindar
// :3000 dentro de app.listen(). Só quem ganhava o bind chegava a executar o
// callback — e com isso, os schedulers dependiam da sorte do EADDRINUSE. Agora:
//  - master NÃO escuta HTTP: roda apenas schedulers (sync PNCP, jornal,
//    recorrências, cobranças, polling boletos). Libera ~180MB de RSS ocioso.
//  - worker escuta :3000 normalmente e não agenda nada.
// Benefício colateral: pronto para multi-tenant (um master por instalação,
// vários workers horizontal-scale) sem re-arranjar o código.
function _logStartupBanner(role) {
  const stats = {
    licitacoes: db.prepare('SELECT COUNT(*) as count FROM licitacoes').get().count,
    itens: db.prepare('SELECT COUNT(*) as count FROM itens').get().count
  };
  console.log(`[${role}] Banco de dados: ${dbPath}`);
  console.log(`[${role}] API do PNCP: ${PNCP_API_BASE}`);
  console.log(`[${role}] API Key extensão: ${apiKey}`);
  console.log(`[${role}] Dados no banco: ${stats.licitacoes} licitações, ${stats.itens} itens`);
  const lastSyncDate = getConfigValue('lastSyncDate');
  if (lastSyncDate) {
    console.log(`[${role}] Última sincronização: ${lastSyncDate}`);
  }
  return stats;
}

function _iniciarSchedulersMaster() {
  _logStartupBanner('master');
  console.log('[master] ROLE=master — schedulers-only (NÃO escuta HTTP)');

  // NFSE-M06 onda 5C passo 2: motor PNCP + 3 timers master-only (watchdog,
  // disputa-alert, verificação diária de lacunas) vivem em
  // pncp-sync-scheduler.js. Na onda 5C passo 4 o entrypoint vira
  // scheduler.js (sem Express) chamando essas mesmas funções.
  pncpSync.iniciarSyncEngine();
  pncpSync.startMasterOnlyTimers();

  // Jornal de Licitações
  agendarJornal(db);
  // Recorrências NFSe
  agendarRecorrencias(db);
  // Cobranças (régua diária)
  agendarCobrancas(db);
  // Polling boletos MercadoPago (a cada 30 min)
  agendarPollingBoletos(db);
  // NFSE-M06: Reconciliador S6 NFSe — decouplado de registrarRotasNfse.
  // Chamada explícita aqui para que o scheduler.js possa chamar o mesmo
  // helper sem precisar montar Express app.
  iniciarReconciliadorS6(db);
}

function _iniciarWorkerHttp() {
  app.listen(PORT, () => {
    _logStartupBanner('worker');
    console.log(`[worker] Servidor rodando em http://localhost:${PORT}`);
    console.log('[worker] Endpoints disponíveis:');
    console.log(`  GET  http://localhost:${PORT}/api/licitacoes`);
    console.log(`  GET  http://localhost:${PORT}/api/licitacoes/:cnpj/:sequencial/:ano`);
    console.log(`  GET  http://localhost:${PORT}/api/orgaos`);
    console.log(`  GET  http://localhost:${PORT}/api/sync/status`);
    console.log(`  POST http://localhost:${PORT}/api/sync/start        (auto: incremental ou completa)`);
    console.log(`  POST http://localhost:${PORT}/api/sync/full         (força sync completa)`);
    console.log(`  POST http://localhost:${PORT}/api/sync/incremental  (força sync incremental)`);
    console.log('[worker] ROLE=worker — HTTP-only (nenhum scheduler rodando aqui)');
  }).on('error', (err) => {
    // Quando o worker perde a corrida do bind, queremos log explícito
    // ao invés de stacktrace cru no uncaughtException.
    if (err && err.code === 'EADDRINUSE') {
      console.error(`[worker] FATAL EADDRINUSE :${PORT} — outro processo já escuta. Abortando.`);
    } else {
      console.error('[worker] FATAL erro no listen:', err);
    }
    process.exit(1);
  });
}

const _SERVER_ROLE = process.env.ROLE || 'master';
if (_SERVER_ROLE === 'master') {
  _iniciarSchedulersMaster();
} else {
  _iniciarWorkerHttp();
}
