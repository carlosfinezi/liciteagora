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
const { createMonitorMensagens } = require('./monitor-mensagens-core');
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

// Armazenar instâncias de monitoramento ativas
const monitoramentosAtivos = new Map();

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
let monitorMensagens = null;

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

/**
 * Endpoint para buscar licitações do banco local
 */
app.get('/api/licitacoes', async (req, res) => {
  try {
    let {
      dataAberturaInicial,
      dataAberturaFinal,
      dataPublicacaoInicial,
      dataPublicacaoFinal,
      palavraChave,
      palavraExclusao,
      grupoExclusaoId,
      codigoModalidadeContratacao,
      uf,
      buscaDetalhada,
      numeroLicitacao,
      uasg,
      ordenacao,
      pagina = 1,
      tamanhoPagina = 50
    } = req.query;

    const usarBuscaDetalhada = buscaDetalhada === 'true';

    // Limitar tamanho da página (evitar queries pesadas)
    tamanhoPagina = Math.min(parseInt(tamanhoPagina) || 50, 100);

    // Configurar ordenação (NULLS LAST para colocar valores nulos no final)
    const ordenacaoValida = {
      'dataEncerramentoProposta_asc': 'CASE WHEN dataEncerramentoProposta IS NULL THEN 1 ELSE 0 END, dataEncerramentoProposta ASC',
      'dataEncerramentoProposta_desc': 'dataEncerramentoProposta DESC',
      'dataPublicacaoPncp_asc': 'CASE WHEN dataPublicacaoPncp IS NULL THEN 1 ELSE 0 END, dataPublicacaoPncp ASC',
      'dataPublicacaoPncp_desc': 'dataPublicacaoPncp DESC',
      'valorTotalEstimado_asc': 'CASE WHEN valorTotalEstimado IS NULL THEN 1 ELSE 0 END, valorTotalEstimado ASC',
      'valorTotalEstimado_desc': 'valorTotalEstimado DESC'
    };
    const orderBy = ordenacaoValida[ordenacao] || 'CASE WHEN dataEncerramentoProposta IS NULL THEN 1 ELSE 0 END, dataEncerramentoProposta ASC';

    // Versão com alias 'l.' para queries com JOIN
    const ordenacaoValidaAlias = {
      'dataEncerramentoProposta_asc': 'CASE WHEN l.dataEncerramentoProposta IS NULL THEN 1 ELSE 0 END, l.dataEncerramentoProposta ASC',
      'dataEncerramentoProposta_desc': 'l.dataEncerramentoProposta DESC',
      'dataPublicacaoPncp_asc': 'CASE WHEN l.dataPublicacaoPncp IS NULL THEN 1 ELSE 0 END, l.dataPublicacaoPncp ASC',
      'dataPublicacaoPncp_desc': 'l.dataPublicacaoPncp DESC',
      'valorTotalEstimado_asc': 'CASE WHEN l.valorTotalEstimado IS NULL THEN 1 ELSE 0 END, l.valorTotalEstimado ASC',
      'valorTotalEstimado_desc': 'l.valorTotalEstimado DESC'
    };
    const orderByAlias = ordenacaoValidaAlias[ordenacao] || 'CASE WHEN l.dataEncerramentoProposta IS NULL THEN 1 ELSE 0 END, l.dataEncerramentoProposta ASC';

    // Versão simplificada para JavaScript sort
    const orderBySimple = {
      'dataEncerramentoProposta_asc': { field: 'dataEncerramentoProposta', dir: 'ASC' },
      'dataEncerramentoProposta_desc': { field: 'dataEncerramentoProposta', dir: 'DESC' },
      'dataPublicacaoPncp_asc': { field: 'dataPublicacaoPncp', dir: 'ASC' },
      'dataPublicacaoPncp_desc': { field: 'dataPublicacaoPncp', dir: 'DESC' },
      'valorTotalEstimado_asc': { field: 'valorTotalEstimado', dir: 'ASC' },
      'valorTotalEstimado_desc': { field: 'valorTotalEstimado', dir: 'DESC' }
    };
    const orderConfig = orderBySimple[ordenacao] || { field: 'dataEncerramentoProposta', dir: 'ASC' };

    let conditions = [];
    let params = [];

    // Filtro por número da licitação
    if (numeroLicitacao) {
      conditions.push("(numeroCompra LIKE ? OR numeroCompra = ?)");
      params.push('%' + numeroLicitacao + '%', numeroLicitacao);
    }

    // Filtro por UASG (padded to 6 digits for exact match, also try without padding)
    if (uasg) {
      const uasgPadded = uasg.padStart(6, '0');
      conditions.push("(codigoUnidade = ? OR codigoUnidade = ?)");
      params.push(uasg, uasgPadded);
    }

    if (dataAberturaInicial) {
      conditions.push('dataEncerramentoProposta >= ?');
      params.push(dataAberturaInicial);
    }
    if (dataAberturaFinal) {
      conditions.push('dataEncerramentoProposta <= ?');
      params.push(dataAberturaFinal + 'T23:59:59');
    }

    // Filtro por data de publicação
    if (dataPublicacaoInicial) {
      conditions.push('dataPublicacaoPncp >= ?');
      params.push(dataPublicacaoInicial);
    }
    if (dataPublicacaoFinal) {
      conditions.push('dataPublicacaoPncp <= ?');
      params.push(dataPublicacaoFinal + 'T23:59:59');
    }

    if (codigoModalidadeContratacao) {
      conditions.push('modalidadeId = ?');
      params.push(parseInt(codigoModalidadeContratacao));
    }

    if (uf) {
      conditions.push('ufSigla = ?');
      params.push(uf.toUpperCase());
    }

    // Filtro por portal/sistema (usa linkSistemaOrigem e usuarioNome)
    const { portal } = req.query;
    if (portal) {
      switch (portal) {
        case 'comprasnet':
          // Compras.gov.br / Comprasnet
          conditions.push("(linkSistemaOrigem LIKE '%comprasnet%' OR linkSistemaOrigem LIKE '%compras.gov%' OR linkSistemaOrigem LIKE '%cnetmobile%' OR LOWER(usuarioNome) = 'compras.gov.br')");
          break;
        case 'portalcompras':
          // Portal de Compras Públicas (Governança Brasil)
          conditions.push("(linkSistemaOrigem LIKE '%portaldecompraspublicas%' OR LOWER(usuarioNome) LIKE '%governançabrasil%' OR LOWER(usuarioNome) LIKE '%governancabrasil%')");
          break;
        case 'licitacoese':
          // Licitações-e (Banco do Brasil)
          conditions.push("(linkSistemaOrigem LIKE '%licitacoes-e%' OR linkSistemaOrigem LIKE '%bb.com%' OR LOWER(usuarioNome) LIKE '%licitacoes-e%' OR LOWER(usuarioNome) LIKE '%banco do brasil%')");
          break;
        case 'bll':
          // BLL Compras / BNC
          conditions.push("(linkSistemaOrigem LIKE '%bll.org%' OR linkSistemaOrigem LIKE '%bllcompras%' OR linkSistemaOrigem LIKE '%bnccompras%' OR LOWER(usuarioNome) LIKE '%bll compras%' OR LOWER(usuarioNome) LIKE '%bolsa nacional de compras%')");
          break;
        case 'licitardigital':
          // Licitar Digital
          conditions.push("(linkSistemaOrigem LIKE '%licitardigital%' OR linkSistemaOrigem LIKE '%app2-compras.licita%' OR LOWER(usuarioNome) LIKE '%licitar digital%')");
          break;
        case 'licitanet':
          // Licitanet
          conditions.push("(linkSistemaOrigem LIKE '%licitanet%' OR LOWER(usuarioNome) LIKE '%licitanet%')");
          break;
        case 'banrisul':
          // Pregão Banrisul
          conditions.push("(linkSistemaOrigem LIKE '%pregaobanrisul%' OR LOWER(usuarioNome) LIKE '%banrisul%')");
          break;
        case 'comprasrs':
          // Compras RS
          conditions.push("(linkSistemaOrigem LIKE '%compras.rs.gov%' OR LOWER(usuarioNome) LIKE '%compras rs%' OR LOWER(usuarioNome) LIKE '%rio grande do sul%')");
          break;
        case 'comprasmg':
          // Portal Compras MG
          conditions.push("(linkSistemaOrigem LIKE '%compras.mg.gov%' OR LOWER(usuarioNome) LIKE '%minas gerais%' OR LOWER(usuarioNome) LIKE '%compras mg%')");
          break;
        case 'compraspa':
          // Compras Pará
          conditions.push("(LOWER(usuarioNome) LIKE '%compras pará%' OR LOWER(usuarioNome) LIKE '%compras para%')");
          break;
        case 'centralpb':
          // Central de Compras da Paraíba
          conditions.push("(LOWER(usuarioNome) LIKE '%central de compras da paraíba%' OR LOWER(usuarioNome) LIKE '%central de compras da paraiba%')");
          break;
        case 'outros':
          // Outros sistemas (inclui sistemas municipais: Fiorilli, IPM, Betha, etc.)
          conditions.push("(linkSistemaOrigem IS NOT NULL OR usuarioNome IS NOT NULL) AND NOT (linkSistemaOrigem LIKE '%comprasnet%' OR linkSistemaOrigem LIKE '%compras.gov%' OR LOWER(usuarioNome) = 'compras.gov.br' OR LOWER(usuarioNome) LIKE '%governançabrasil%' OR LOWER(usuarioNome) LIKE '%bll compras%' OR LOWER(usuarioNome) LIKE '%licitar digital%')");
          break;
      }
    }

    let whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

    let sql;
    if (palavraChave) {
      // Verificar se são múltiplas palavras separadas por vírgula
      const palavras = palavraChave.split(',').map(p => p.trim().toLowerCase()).filter(p => p.length > 0);

      if (palavras.length > 1) {
        // Múltiplas palavras - busca otimizada com OR
        // Usar filtros de data do usuário ou últimos 60 dias como fallback
        let dateCondition = '';
        let dateParams = [];

        if (dataAberturaInicial && dataAberturaFinal) {
          dateCondition = 'dataEncerramentoProposta >= ? AND dataEncerramentoProposta <= ?';
          dateParams = [dataAberturaInicial, dataAberturaFinal + 'T23:59:59'];
        } else {
          const dataLimite = new Date();
          dataLimite.setDate(dataLimite.getDate() - 60);
          dateCondition = 'dataPublicacaoPncp >= ?';
          dateParams = [dataLimite.toISOString().split('T')[0]];
        }

        // Etapa 1: Busca rápida no objetoCompra
        const conditionsObjeto = palavras.map(() => `objetoCompra LIKE ?`).join(' OR ');
        const paramsObjeto = palavras.map(p => `%${p}%`);

        const licitacoesObjeto = db.prepare(`
          SELECT * FROM licitacoes
          WHERE ${dateCondition} AND (${conditionsObjeto})
          ORDER BY ${orderBy}
          LIMIT 300
        `).all(...dateParams, ...paramsObjeto);

        // Etapa 2: Busca nos itens
        const conditionsItens = palavras.map(() => `i.descricao LIKE ?`).join(' OR ');
        const paramsItens = palavras.map(p => `%${p}%`);

        const licitacoesItens = db.prepare(`
          SELECT DISTINCT l.* FROM licitacoes l
          WHERE l.id IN (
            SELECT DISTINCT i.licitacaoId FROM itens i
            WHERE i.licitacaoId IN (SELECT id FROM licitacoes WHERE ${dateCondition})
              AND (${conditionsItens})
            LIMIT 300
          )
          ORDER BY ${orderBy}
        `).all(...dateParams, ...paramsItens);

        // Combinar resultados únicos
        const licitacoesMap = new Map();
        [...licitacoesObjeto, ...licitacoesItens].forEach(l => {
          if (!licitacoesMap.has(l.id)) licitacoesMap.set(l.id, l);
        });

        let todasLicitacoes = Array.from(licitacoesMap.values());

        // Aplicar ordenação aos resultados combinados (NULL sempre por último)
        const { field: orderField, dir: orderDir } = orderConfig;
        todasLicitacoes.sort((a, b) => {
          let valA = a[orderField];
          let valB = b[orderField];
          // NULL sempre por último
          if (valA == null && valB == null) return 0;
          if (valA == null) return 1;
          if (valB == null) return -1;
          if (typeof valA === 'string') valA = valA.toLowerCase();
          if (typeof valB === 'string') valB = valB.toLowerCase();
          if (orderDir === 'DESC') return valA > valB ? -1 : valA < valB ? 1 : 0;
          return valA < valB ? -1 : valA > valB ? 1 : 0;
        });

        // Aplicar filtros adicionais se houver
        if (conditions.length > 0) {
          // Re-filtrar com as condições adicionais usando SQL
          const idsEncontrados = todasLicitacoes.map(l => l.id);
          if (idsEncontrados.length > 0) {
            const placeholders = idsEncontrados.map(() => '?').join(',');
            todasLicitacoes = db.prepare(`
              SELECT * FROM licitacoes
              ${whereClause}
              ${conditions.length > 0 ? 'AND' : 'WHERE'} id IN (${placeholders})
              ORDER BY ${orderBy}
            `).all(...params, ...idsEncontrados);
          } else {
            todasLicitacoes = [];
          }
        }

        // Pular para o processamento de exclusão e paginação
        sql = null; // Sinaliza que já temos os resultados
        var resultadosPreProcessados = todasLicitacoes;
      } else {
        // Palavra única - busca normal
        const palavraParam = `%${palavraChave.toLowerCase()}%`;
        sql = `
          SELECT DISTINCT l.* FROM licitacoes l
          LEFT JOIN itens i ON l.id = i.licitacaoId
          ${whereClause}
          ${conditions.length > 0 ? 'AND' : 'WHERE'} (
            LOWER(l.objetoCompra) LIKE ?
            OR LOWER(l.informacaoComplementar) LIKE ?
            OR LOWER(l.razaoSocial) LIKE ?
            OR LOWER(l.nomeUnidade) LIKE ?
            OR LOWER(i.descricao) LIKE ?
          )
          ORDER BY ${orderByAlias}
        `;
        params.push(palavraParam, palavraParam, palavraParam, palavraParam, palavraParam);
      }
    } else {
      sql = `
        SELECT * FROM licitacoes
        ${whereClause}
        ORDER BY ${orderBy}
      `;
    }

    // Se sql é null, já temos os resultados pré-processados
    let todasLicitacoes = sql ? db.prepare(sql).all(...params) : resultadosPreProcessados;

    // Filtrar palavras de exclusão (inclui busca nos itens)
    if (palavraExclusao) {
      const exclusoes = palavraExclusao.toLowerCase().split(',').map(p => p.trim()).filter(p => p);
      if (exclusoes.length > 0) {
        todasLicitacoes = todasLicitacoes.filter(lic => {
          // Texto da licitação
          let texto = (
            (lic.objetoCompra || '') + ' ' +
            (lic.informacaoComplementar || '') + ' ' +
            (lic.razaoSocial || '') + ' ' +
            (lic.nomeUnidade || '')
          ).toLowerCase();

          // Adicionar descrição dos itens
          const itensRows = db.prepare('SELECT descricao FROM itens WHERE licitacaoId = ?').all(lic.id);
          itensRows.forEach(item => {
            texto += ' ' + (item.descricao || '').toLowerCase();
          });

          return !exclusoes.some(exc => texto.includes(exc));
        });
      }
    }


    // Filtrar por grupo de exclusão
    if (grupoExclusaoId) {
      const grupoExclusao = db.prepare('SELECT id FROM grupos_palavras WHERE id = ? AND tipo = ?').get(grupoExclusaoId, 'exclusao');
      if (grupoExclusao) {
        const palavrasGrupo = db.prepare('SELECT palavra FROM grupos_palavras_itens WHERE grupoId = ?').all(grupoExclusaoId);
        const exclusoesGrupo = palavrasGrupo.map(p => p.palavra.toLowerCase().trim()).filter(p => p);

        if (exclusoesGrupo.length > 0) {
          todasLicitacoes = todasLicitacoes.filter(lic => {
            let texto = (
              (lic.objetoCompra || '') + ' ' +
              (lic.informacaoComplementar || '') + ' ' +
              (lic.razaoSocial || '') + ' ' +
              (lic.nomeUnidade || '')
            ).toLowerCase();

            const itensRows = db.prepare('SELECT descricao FROM itens WHERE licitacaoId = ?').all(lic.id);
            itensRows.forEach(item => {
              texto += ' ' + (item.descricao || '').toLowerCase();
            });

            return !exclusoesGrupo.some(exc => texto.includes(exc));
          });
        }
      }
    }

    const licitacoesFormatadas = todasLicitacoes.map(row => {
      let dados = {};

      // Se dadosCompletos existir e não estiver vazio, usar ele
      if (row.dadosCompletos && row.dadosCompletos !== '{}') {
        dados = JSON.parse(row.dadosCompletos);
      } else {
        // Construir objeto a partir dos campos da tabela
        dados = {
          orgaoEntidade: {
            cnpj: row.cnpj,
            razaoSocial: row.razaoSocial
          },
          unidadeOrgao: {
            ufSigla: row.ufSigla,
            ufNome: row.ufSigla, // Usar sigla como fallback
            municipioNome: row.municipioNome,
            nomeUnidade: row.nomeUnidade,
            codigoUnidade: row.codigoUnidade
          },
          numeroControlePNCP: row.numeroControlePNCP,
          anoCompra: row.anoCompra,
          sequencialCompra: row.sequencialCompra,
          numeroCompra: row.numeroCompra,
          processo: row.processo,
          modalidadeId: row.modalidadeId,
          modalidadeNome: row.modalidadeNome,
          objetoCompra: row.objetoCompra,
          informacaoComplementar: row.informacaoComplementar,
          valorTotalEstimado: row.valorTotalEstimado,
          dataPublicacaoPncp: row.dataPublicacaoPncp,
          dataAberturaProposta: row.dataAberturaProposta,
          dataEncerramentoProposta: row.dataEncerramentoProposta,
          situacaoCompraNome: row.situacaoCompraNome,
          linkSistemaOrigem: row.linkSistemaOrigem,
          srp: row.srp === 1,
          dataAtualizacao: row.dataAtualizacao,
          usuarioNome: row.usuarioNome
        };
      }

      if (usarBuscaDetalhada) {
        const itensRows = db.prepare('SELECT dadosCompletos FROM itens WHERE licitacaoId = ?').all(row.id);
        dados.itens = itensRows.map(i => JSON.parse(i.dadosCompletos || '{}'));
      }

      return dados;
    });

    const tamanho = parseInt(tamanhoPagina);
    const paginaInt = parseInt(pagina);
    const inicio = (paginaInt - 1) * tamanho;
    const fim = inicio + tamanho;
    const licitacoesPaginadas = licitacoesFormatadas.slice(inicio, fim);

    res.json({
      success: true,
      data: {
        data: licitacoesPaginadas,
        totalRegistros: licitacoesFormatadas.length,
        totalPaginas: Math.ceil(licitacoesFormatadas.length / tamanho),
        numeroPagina: paginaInt,
        empty: licitacoesPaginadas.length === 0
      },
      // NFSE-M06 onda 5C passo 2: syncStatus vem do módulo pncp-sync-scheduler.
      // No worker (quem serve HTTP) os campos in-memory ficam zerados pois sync
      // roda no master; os campos persistidos abaixo + GET /api/sync/status
      // preenchem o estado real da UI.
      syncStatus: (() => {
        const _ss = pncpSync.getSyncStatus();
        return {
          running: _ss.running,
          type: _ss.type,
          progress: _ss.progress,
          total: _ss.total,
          lastSync: _ss.lastSync,
          lastIncrementalSync: _ss.lastIncrementalSync,
          nextScheduledSync: _ss.nextScheduledSync,
          licitacoesNoBanco: db.prepare('SELECT COUNT(*) as count FROM licitacoes').get().count,
          itensNoBanco: db.prepare('SELECT COUNT(*) as count FROM itens').get().count
        };
      })()
    });

  } catch (error) {
    console.error('Erro ao buscar licitações:', error.message);
    res.status(500).json({
      success: false,
      error: 'Erro ao buscar licitações',
      details: error.message
    });
  }
});



/**
 * Endpoint para buscar detalhes de uma licitação específica
 */
app.get('/api/licitacoes/:cnpj/:sequencial/:ano', async (req, res) => {
  try {
    const { cnpj, sequencial, ano } = req.params;

    const numeroControlePNCP = `${cnpj}-1-${String(sequencial).padStart(6, '0')}/${ano}`;
    const local = db.prepare('SELECT dadosCompletos FROM licitacoes WHERE numeroControlePNCP = ?').get(numeroControlePNCP);

    if (local) {
      return res.json({
        success: true,
        data: JSON.parse(local.dadosCompletos),
        source: 'local'
      });
    }

    const response = await axios.get(
      `${PNCP_API_BASE}/orgaos/${cnpj}/compras/${ano}/${sequencial}`,
      {
        headers: { 'Accept': 'application/json' },
        timeout: 30000
      }
    );

    res.json({
      success: true,
      data: response.data,
      source: 'api'
    });

  } catch (error) {
    console.error('Erro ao buscar detalhes da licitação:', error.message);
    res.status(error.response?.status || 500).json({
      success: false,
      error: 'Erro ao buscar detalhes da licitação',
      details: error.message
    });
  }
});

/**
 * Endpoint para buscar órgãos
 */
app.get('/api/orgaos', async (req, res) => {
  try {
    const { q, pagina = 1, tamanhoPagina = 50 } = req.query;

    const params = {
      pagina: parseInt(pagina),
      tamanhoPagina: parseInt(tamanhoPagina)
    };

    if (q) params.q = q;

    const response = await axios.get(`${PNCP_API_BASE}/orgaos`, {
      params,
      headers: { 'Accept': 'application/json' },
      timeout: 30000
    });

    res.json({
      success: true,
      data: response.data
    });

  } catch (error) {
    console.error('Erro ao buscar órgãos:', error.message);
    res.status(error.response?.status || 500).json({
      success: false,
      error: 'Erro ao buscar órgãos',
      details: error.message
    });
  }
});



/**
 * Endpoint para buscar itens de uma licitacao
 */
app.get('/api/licitacoes/:cnpj/:sequencial/:ano/itens', async (req, res) => {
  try {
    const { cnpj, sequencial, ano } = req.params;

    // Primeiro tenta buscar do banco local
    const numeroControlePNCP = cnpj + '-1-' + String(sequencial).padStart(6, '0') + '/' + ano;
    const localItems = db.prepare(`
      SELECT i.* FROM itens i
      INNER JOIN licitacoes l ON i.licitacaoId = l.id
      WHERE l.numeroControlePNCP = ?
    `).all(numeroControlePNCP);

    if (localItems.length > 0) {
      const items = localItems.map(item => {
        // Se dadosCompletos existir e não estiver vazio, usar ele
        if (item.dadosCompletos && item.dadosCompletos !== '{}' && item.dadosCompletos.length > 2) {
          try {
            return JSON.parse(item.dadosCompletos);
          } catch (e) {
            // Fall through to use table fields
          }
        }

        // Construir objeto a partir dos campos da tabela
        return {
          numeroItem: item.numeroItem,
          descricao: item.descricao,
          descricaoDetalhada: item.descricao,
          quantidade: item.quantidade,
          unidadeMedida: item.unidadeMedida,
          valorUnitarioEstimado: item.valorUnitarioEstimado,
          valorTotal: item.valorTotal
        };
      });

      return res.json({
        success: true,
        data: items,
        source: 'local'
      });
    }

    // Se nao encontrou localmente, busca da API com paginação
    const todosItens = [];
    let pagina = 1;
    let temMais = true;

    while (temMais) {
      const response = await axios.get(
        PNCP_API_ITENS + '/orgaos/' + cnpj + '/compras/' + ano + '/' + sequencial + '/itens',
        {
          params: { pagina, tamanhoPagina: 100 },
          headers: { 'Accept': 'application/json' },
          timeout: 30000
        }
      );

      const itens = response.data || [];
      if (itens.length > 0) {
        todosItens.push(...itens);
        pagina++;
        if (itens.length < 100) temMais = false;
      } else {
        temMais = false;
      }
    }

    res.json({
      success: true,
      data: todosItens,
      source: 'api'
    });

  } catch (error) {
    console.error('Erro ao buscar itens:', error.message);
    res.status(error.response?.status || 500).json({
      success: false,
      error: 'Erro ao buscar itens',
      details: error.message
    });
  }
});

/**
 * Endpoint para ressincronizar itens de uma licitação específica
 */
app.post('/api/licitacoes/:cnpj/:sequencial/:ano/sync-itens', async (req, res) => {
  try {
    const { cnpj, sequencial, ano } = req.params;

    // Buscar itens da API do PNCP
    // NFSE-M06 onda 5C passo 2: helper puro exportado pelo pncp-sync-scheduler.
    const itens = await pncpSync.buscarItensLicitacao(cnpj, parseInt(ano), parseInt(sequencial));

    if (itens.length === 0) {
      return res.json({ success: false, error: 'Nenhum item encontrado na API' });
    }

    // Construir número de controle PNCP
    const numeroControlePNCP = `${cnpj}-1-${String(sequencial).padStart(6, '0')}/${ano}`;

    // Salvar itens no banco
    const salvou = salvarItens(numeroControlePNCP, itens);

    if (salvou) {
      res.json({
        success: true,
        message: `${itens.length} itens sincronizados com sucesso`,
        totalItens: itens.length
      });
    } else {
      res.json({ success: false, error: 'Erro ao salvar itens no banco' });
    }

  } catch (error) {
    console.error('Erro ao sincronizar itens:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== CERTIFICADO DIGITAL — extraído ====================
// NFSE-M06 onda 6.7 (2026-04-20): 3 rotas (status/save/delete) migradas
// para certificado-routes.js.

// ==================== TELEGRAM / ALERTAS ====================

// Função para enviar mensagem no Telegram (HTML)
// NFSE-M06 onda 5C: corpo extraído para telegram-client.js para que o
// scheduler.js (processo master sem Express) possa usar a mesma lógica
// sem require server.js. Callers aqui continuam chamando enviarTelegram(msg).
const { sendTelegram: _sendTelegramViaClient } = require('./telegram-client');
async function enviarTelegram(mensagem) {
  return _sendTelegramViaClient(db, mensagem);
}

// Função para enviar notificação formatada do chat de licitação
async function enviarNotificacaoTelegram(dados) {
  try {
    const config = db.prepare('SELECT botToken, chatId FROM telegram_config WHERE id = 1 AND ativo = 1').get();
    if (!config || !config.botToken || !config.chatId) {
      console.log('[Telegram] Não configurado ou desativado');
      return false;
    }

    // Se recebeu uma string simples, envia como está
    if (typeof dados === 'string') {
      return await enviarTelegram(dados);
    }

    // Formata a mensagem com todos os dados
    const {
      cnpjOrgao,
      nomeOrgao,
      sequencial,
      ano,
      objetoLicitacao,
      remetente,
      mensagem,
      dataHoraMensagem,
      temCnpjFornecedor,
      palavrasChave
    } = dados;

    // Formata data
    let dataFormatada = 'N/A';
    if (dataHoraMensagem) {
      try {
        const data = new Date(dataHoraMensagem);
        dataFormatada = data.toLocaleString('pt-BR', {
          day: '2-digit',
          month: '2-digit',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit'
        });
      } catch (e) {
        dataFormatada = dataHoraMensagem;
      }
    }

    // Monta a mensagem formatada
    let textoMensagem = `📨 <b>NOVA MENSAGEM NO CHAT</b>\n`;
    textoMensagem += `━━━━━━━━━━━━━━━━━━━━\n\n`;

    // Dados do órgão
    textoMensagem += `🏛️ <b>ÓRGÃO:</b>\n`;
    textoMensagem += `${nomeOrgao || 'Não identificado'}\n`;
    if (cnpjOrgao) {
      textoMensagem += `UASG/CNPJ: ${cnpjOrgao}\n`;
    }
    textoMensagem += `\n`;

    // Dados da licitação
    textoMensagem += `📋 <b>LICITAÇÃO:</b>\n`;
    textoMensagem += `Nº ${sequencial}/${ano}\n`;
    if (objetoLicitacao) {
      const objetoResumido = objetoLicitacao.length > 150
        ? objetoLicitacao.substring(0, 150) + '...'
        : objetoLicitacao;
      textoMensagem += `<i>${objetoResumido}</i>\n`;
    }
    textoMensagem += `\n`;

    // Data e remetente
    textoMensagem += `📅 <b>Data:</b> ${dataFormatada}\n`;
    textoMensagem += `👤 <b>De:</b> ${remetente || 'Sistema'}\n\n`;

    // Mensagem
    textoMensagem += `💬 <b>MENSAGEM:</b>\n`;
    textoMensagem += `━━━━━━━━━━━━━━━━━━━━\n`;
    const mensagemResumida = mensagem.length > 500
      ? mensagem.substring(0, 500) + '...'
      : mensagem;
    textoMensagem += `${mensagemResumida}\n`;
    textoMensagem += `━━━━━━━━━━━━━━━━━━━━\n\n`;

    // Alertas especiais
    if (temCnpjFornecedor) {
      textoMensagem += `⚠️ <b>ATENÇÃO: Menciona seu CNPJ!</b>\n`;
    }
    if (palavrasChave && palavrasChave.length > 0) {
      textoMensagem += `🔔 <b>Palavras-chave:</b> ${palavrasChave.join(', ')}\n`;
    }

    const url = `https://api.telegram.org/bot${config.botToken}/sendMessage`;
    const response = await axios.post(url, {
      chat_id: config.chatId,
      text: textoMensagem,
      parse_mode: 'HTML'
    });

    if (response.data.ok) {
      console.log(`[Telegram] Notificação enviada: Licitação ${sequencial}/${ano}`);
    }

    return response.data.ok;
  } catch (error) {
    console.error('[Telegram] Erro ao enviar notificação:', error.message);
    return false;
  }
}

// ==================== ALERTA DISPUTA (Telegram 30 min antes) ====================
// NFSE-M06 onda 5C passo 2: verificarAlertasDisputa + timer (setInterval 5min
// e setTimeout 30s pós-boot) migraram para pncp-sync-scheduler.js. O master
// liga tudo via pncpSync.startMasterOnlyTimers(). No worker não roda — o gate
// ROLE=master que existia aqui desde a onda 5B deixa de ser necessário porque
// o módulo só dispara os timers quando o master explicitamente solicita.

// ==================== CREDENCIAIS GOV.BR ====================

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
registrarRotasExtensaoChrome(app, db, { getConfigValue, enviarNotificacaoTelegram, getMonitor: () => monitorMensagens });
registrarRotasChatMonitoramento(app, db);
registrarRotasChatMensagens(app, db);
registrarRotasParticipacaoMonitoramento(app, db, { enviarTelegram });
// Verificar status das credenciais gov.br
app.get('/api/govbr/status', (req, res) => {
  try {
    const cpf = getConfigValue('govbr_cpf');

    if (cpf) {
      // Mascarar o CPF para exibição
      const cpfMascarado = cpf.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.***.***-$4');
      res.json({
        success: true,
        configurado: true,
        cpf: cpfMascarado
      });
    } else {
      res.json({
        success: true,
        configurado: false
      });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Salvar credenciais gov.br
app.post('/api/govbr/config', async (req, res) => {
  try {
    const { cpf, senha } = req.body;

    if (!cpf || !senha) {
      return res.status(400).json({ success: false, error: 'CPF e senha são obrigatórios' });
    }

    // Limpar CPF (remover pontos e traços)
    const cpfLimpo = cpf.replace(/\D/g, '');

    if (cpfLimpo.length !== 11) {
      return res.status(400).json({ success: false, error: 'CPF inválido' });
    }

    // Salvar no banco
    setConfigValue('govbr_cpf', cpfLimpo);
    setConfigValue('govbr_senha', senha);

    console.log('[Gov.br] Credenciais salvas');

    // Tentar iniciar o monitor de mensagens
    if (!monitorMensagens || !monitorMensagens.ativo) {
      console.log('[Gov.br] Iniciando monitor de mensagens...');
      monitorMensagens = new MonitorMensagensComprasnet();
      monitorMensagens.iniciar().catch(error => {
        console.error('[Monitor Mensagens] Erro ao iniciar:', error.message);
      });
    }

    res.json({
      success: true,
      message: 'Credenciais salvas com sucesso'
    });

  } catch (error) {
    console.error('Erro ao salvar credenciais gov.br:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Remover credenciais gov.br
app.delete('/api/govbr/config', async (req, res) => {
  try {
    // Parar o monitor se estiver ativo
    if (monitorMensagens && monitorMensagens.ativo) {
      await monitorMensagens.parar();
      monitorMensagens = null;
    }

    // Remover credenciais
    db.prepare("DELETE FROM config WHERE chave = 'govbr_cpf'").run();
    db.prepare("DELETE FROM config WHERE chave = 'govbr_senha'").run();

    res.json({ success: true, message: 'Credenciais removidas' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});


// ==================== ROBÔ DE MONITORAMENTO DE MENSAGENS DO COMPRASNET ====================

// Instância única do monitor de mensagens

// NFSE-M06 onda 6.26 (2026-04-20): classes MonitorMensagensComprasnet +
// MonitorChat migradas para monitor-mensagens-core.js. Factory recebe
// db/getConfigValue/enviarTelegram via closure.
const { MonitorMensagensComprasnet, MonitorChat } = createMonitorMensagens({
  db, getConfigValue, enviarTelegram
});

// Iniciar monitoramento de uma licitação
app.post('/api/chat/iniciar-monitoramento', async (req, res) => {
  try {
    const { cnpj, ano, sequencial } = req.body;

    if (!cnpj || !ano || !sequencial) {
      return res.status(400).json({ success: false, error: 'Dados incompletos' });
    }

    const key = `${cnpj}-${ano}-${sequencial}`;

    // Verificar se já está monitorando
    if (monitoramentosAtivos.has(key)) {
      return res.status(400).json({ success: false, error: 'Já está sendo monitorado' });
    }

    // Buscar link do sistema
    const licitacao = db.prepare(`
      SELECT linkSistemaOrigem, objetoCompra
      FROM licitacoes
      WHERE cnpj = ? AND anoCompra = ? AND sequencialCompra = ?
    `).get(cnpj, parseInt(ano), parseInt(sequencial));

    if (!licitacao) {
      return res.status(404).json({ success: false, error: 'Licitação não encontrada' });
    }

    // Criar monitor
    const monitor = new MonitorChat(cnpj, ano, sequencial, licitacao.linkSistemaOrigem);
    monitoramentosAtivos.set(key, monitor);

    // Iniciar em background
    monitor.iniciar().catch(error => {
      console.error('Erro no monitoramento:', error);
      monitoramentosAtivos.delete(key);
    });

    res.json({ success: true, message: 'Monitoramento iniciado' });

  } catch (error) {
    console.error('Erro ao iniciar monitoramento:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Parar monitoramento
app.post('/api/chat/parar-monitoramento', async (req, res) => {
  try {
    const { cnpj, ano, sequencial } = req.body;
    const key = `${cnpj}-${ano}-${sequencial}`;

    const monitor = monitoramentosAtivos.get(key);
    if (monitor) {
      await monitor.parar();
      monitoramentosAtivos.delete(key);
    }

    res.json({ success: true, message: 'Monitoramento parado' });

  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Status do monitoramento
app.get('/api/chat/status-monitoramento/:cnpj/:ano/:sequencial', (req, res) => {
  try {
    const { cnpj, ano, sequencial } = req.params;
    const key = `${cnpj}-${ano}-${sequencial}`;

    const monitor = monitoramentosAtivos.get(key);
    if (monitor) {
      res.json({ success: true, ...monitor.getStatus() });
    } else {
      res.json({ success: true, ativo: false, logs: [] });
    }

  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Listar todos os monitoramentos ativos
app.get('/api/chat/monitoramentos-ativos', (req, res) => {
  try {
    const ativos = [];
    for (const [key, monitor] of monitoramentosAtivos) {
      ativos.push({
        key,
        cnpj: monitor.cnpj,
        ano: monitor.ano,
        sequencial: monitor.sequencial,
        ativo: monitor.ativo
      });
    }
    res.json({ success: true, data: ativos });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});



// Função para auto-iniciar monitoramento de mensagens
async function autoIniciarMonitoramentoMensagens() {
  try {
    // Verificar se tem certificado digital OU credenciais gov.br
    const cert = db.prepare('SELECT id FROM certificado_digital WHERE id = 1 AND certificadoBase64 IS NOT NULL').get();
    const cpf = getConfigValue('govbr_cpf');
    const senha = getConfigValue('govbr_senha');

    const temCertificado = !!cert;
    const temCredenciais = cpf && senha;

    if (!temCertificado && !temCredenciais) {
      console.log('[Monitor Mensagens] Nenhum método de autenticação configurado (certificado ou CPF/senha)');
      console.log('[Monitor Mensagens] Configure em: http://localhost:3000/fornecedor.html');
      return;
    }

    console.log(`[Monitor Mensagens] Iniciando com ${temCertificado ? 'certificado digital' : 'CPF/senha'}...`);

    // Criar e iniciar o monitor
    monitorMensagens = new MonitorMensagensComprasnet();
    monitorMensagens.iniciar().catch(error => {
      console.error('[Monitor Mensagens] Erro ao iniciar:', error.message);
      monitorMensagens = null;
    });

  } catch (error) {
    console.error('[Monitor Mensagens] Erro ao auto-iniciar:', error.message);
  }
}

console.log('Rotas de monitoramento de mensagens registradas!');

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
