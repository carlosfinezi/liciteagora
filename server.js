const express = require('express');
const cors = require('cors');
const axios = require('axios');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const forge = require('node-forge');
const { SignPdf } = require('@signpdf/signpdf');
const { P12Signer } = require('@signpdf/signer-p12');
const { plainAddPlaceholder } = require('@signpdf/placeholder-plain');
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
// ─── Download do Electron para Windows ─────────────────────────────────────
app.get('/api/electron/download', (req, res) => {
  const paths = [
    path.join(__dirname, 'electron-standalone', 'dist', 'LiciteAgora-v2.zip'),
    path.join(__dirname, '..', 'public_html', 'LiciteAgora-v2.zip'),
  ];
  const filePath = paths.find(p => fs.existsSync(p));
  if (!filePath) return res.status(404).json({ error: 'Build não encontrado' });
  res.setHeader('Content-Disposition', 'attachment; filename=LiciteAgora-Electron.zip');
  res.sendFile(filePath);
});

// ─── Erros do Electron remoto (sem auth) ───────────────────────────────────
const electronErrors = [];
app.post('/api/electron/error', (req, res) => {
  const err = req.body || {};
  err.receivedAt = new Date().toISOString();
  electronErrors.push(err);
  if (electronErrors.length > 100) electronErrors.shift();
  console.error('[Electron Error] ' + (err.context || '') + ': ' + (err.error || ''));
  res.json({ ok: true });
});
app.get('/api/electron/errors', (req, res) => { res.json(electronErrors); });

// ─── Versão do Electron (para auto-update, sem auth) ────────────────────────
const ELECTRON_VERSION = '1.1.0'; // Incrementar ao publicar nova versão
app.get('/api/electron/check-version', (req, res) => {
  const downloadUrl = (req.protocol + '://' + req.get('host')) + '/api/electron/download-exe';
  res.json({
    version: ELECTRON_VERSION,
    downloadUrl,
    releaseNotes: 'Session timers, mensagens v1 global, auto-update',
  });
});

app.get('/api/electron/download-exe', (req, res) => {
  const paths = [
    path.join(__dirname, 'electron-standalone', 'dist', 'LiciteAgora-Browser.exe'),
    path.join(__dirname, '..', 'public_html', 'downloads', 'LiciteAgora-Browser.exe'),
  ];
  const filePath = paths.find(p => fs.existsSync(p));
  if (!filePath) return res.status(404).json({ error: 'Exe não encontrado' });
  res.setHeader('Content-Disposition', 'attachment; filename=LiciteAgora-Browser.exe');
  res.sendFile(filePath);
});

// ─── Status/Logs do Electron remoto ────────────────────────────────────────
const electronState = { logs: [], state: 'offline', bearerAge: null, lastSeen: null };
app.post('/api/electron/logs', (req, res) => {
  const key = req.headers['x-api-key'];
  if (key !== apiKey) return res.status(401).json({ error: 'API key inválida' });
  const { logs, state: elState, bearerAge } = req.body || {};
  if (Array.isArray(logs)) {
    electronState.logs.push(...logs);
    if (electronState.logs.length > 500) electronState.logs = electronState.logs.slice(-500);
  }
  if (elState) electronState.state = elState;
  if (bearerAge !== undefined) electronState.bearerAge = bearerAge;
  electronState.lastSeen = new Date().toISOString();
  res.json({ ok: true });
});
app.get('/api/electron/status', (req, res) => {
  const since = req.query.since ? new Date(req.query.since).toISOString() : null;
  let logs = electronState.logs;
  if (since) logs = logs.filter(l => l.time > since);
  res.json({ state: electronState.state, bearerAge: electronState.bearerAge, lastSeen: electronState.lastSeen, logCount: electronState.logs.length, logs });
});

// ─── Endpoint para Electron remoto buscar credenciais ──────────────────────
// SEC-01 (2026-04-18): exige X-Api-Key. Electron que ainda não tem a chave deve
// receber via --api-key, LICITEAGORA_API_KEY ou configuração manual inicial.
// NUNCA devolver apiKey no corpo — rotaciona-la exige deploy manual.
app.get('/api/electron/credentials', (req, res) => {
  try {
    const headerKey = req.headers['x-api-key'];
    if (!headerKey || headerKey !== apiKey) {
      return res.status(401).json({ error: 'X-Api-Key obrigatório' });
    }
    const cpf = db.prepare("SELECT valor FROM config WHERE chave = 'govbr_cpf'").get();
    const senha = db.prepare("SELECT valor FROM config WHERE chave = 'govbr_senha'").get();
    if (!cpf || !senha) return res.json({ error: 'Credenciais não configuradas' });
    // apiKey NÃO é mais devolvida aqui — o cliente já precisa tê-la para passar na validação acima.
    res.json({ cpf: cpf.valor, senha: senha.valor });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

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

// ==================== ROTAS DE LEITURA DE MENSAGENS ====================
// Definidas no início para funcionar corretamente com Express 5

// Contar mensagens não lidas
app.get('/api/chat/nao-lidas', (req, res) => {
  try {
    const result = db.prepare('SELECT COUNT(*) as total FROM chat_mensagens WHERE lido = 0 OR lido IS NULL').get();
    res.json({ success: true, total: result ? result.total : 0 });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Marcar mensagem específica como lida
app.post('/api/chat/marcar-lida', (req, res) => {
  try {
    const { id } = req.body;
    const agora = new Date().toISOString();
    db.prepare('UPDATE chat_mensagens SET lido = 1, dataLeitura = ? WHERE id = ?').run(agora, id);
    console.log(`[Chat] Mensagem ${id} marcada como lida`);
    res.json({ success: true, message: 'Mensagem marcada como lida' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Marcar todas mensagens como lidas
app.post('/api/chat/marcar-todas-lidas', (req, res) => {
  try {
    const { cnpjOrgao, ano, sequencial } = req.body;
    const agora = new Date().toISOString();

    if (cnpjOrgao && ano && sequencial) {
      db.prepare('UPDATE chat_mensagens SET lido = 1, dataLeitura = ? WHERE cnpjOrgao = ? AND ano = ? AND sequencial = ? AND (lido = 0 OR lido IS NULL)')
        .run(agora, cnpjOrgao, parseInt(ano), parseInt(sequencial));
    } else {
      db.prepare('UPDATE chat_mensagens SET lido = 1, dataLeitura = ? WHERE lido = 0 OR lido IS NULL').run(agora);
    }

    res.json({ success: true, message: 'Mensagens marcadas como lidas' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

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
 * Endpoint para consultar status da sincronização
 */
app.get('/api/sync/status', (req, res) => {
  try {
    // Estatísticas do banco
    const licitacoesCount = db.prepare('SELECT COUNT(*) as count FROM licitacoes').get().count;
    const itensCount = db.prepare('SELECT COUNT(*) as count FROM itens').get().count;

    // Configurações de sync
    const lastFullSync = db.prepare("SELECT valor FROM config WHERE chave = 'lastFullSync'").get();
    const lastIncrementalSync = db.prepare("SELECT valor FROM config WHERE chave = 'lastIncrementalSync'").get();
    const lastSyncDate = db.prepare("SELECT valor FROM config WHERE chave = 'lastSyncDate'").get();

    // Calcular dias desatualizados
    const hoje = new Date();
    hoje.setHours(0, 0, 0, 0);
    let diasDesatualizados = 0;
    let lastSyncDateStr = lastSyncDate ? lastSyncDate.valor : null;

    if (lastSyncDateStr) {
      const dataSync = new Date(lastSyncDateStr + 'T00:00:00');
      diasDesatualizados = Math.floor((hoje - dataSync) / (1000 * 60 * 60 * 24));
      if (diasDesatualizados < 0) diasDesatualizados = 0;
    }

    // Licitações futuras (data de encerramento > hoje)
    const licitacoesFuturasResult = db.prepare("SELECT COUNT(*) as count FROM licitacoes WHERE dataEncerramentoProposta > datetime('now')").get();
    const licitacoesFuturas = licitacoesFuturasResult ? licitacoesFuturasResult.count : 0;

    // Cobertura futura em dias
    const maxDataFutura = db.prepare("SELECT MAX(date(dataEncerramentoProposta)) as maxData FROM licitacoes WHERE dataEncerramentoProposta > datetime('now') AND dataEncerramentoProposta < datetime('now', '+365 days')").get();

    let coberturaFuturaDias = 0;
    if (maxDataFutura && maxDataFutura.maxData) {
      const dataMax = new Date(maxDataFutura.maxData + 'T00:00:00');
      coberturaFuturaDias = Math.floor((dataMax - hoje) / (1000 * 60 * 60 * 24));
      if (coberturaFuturaDias < 0) coberturaFuturaDias = 0;
    }

    // NFSE-M06 onda 5C passo 2: estado in-memory vem do módulo
    // pncp-sync-scheduler (zerado no worker, populado no master).
    const _ss = pncpSync.getSyncStatus();
    res.json({
      running: _ss.running,
      type: _ss.type,
      progress: _ss.progress,
      total: _ss.total,
      currentDay: _ss.currentDay,
      licitacoesNoBanco: licitacoesCount,
      itensNoBanco: itensCount,
      lastFullSync: lastFullSync ? lastFullSync.valor : null,
      lastIncrementalSync: lastIncrementalSync ? lastIncrementalSync.valor : null,
      lastSyncDate: lastSyncDateStr,
      diasDesatualizados,
      coberturaFuturaDias,
      licitacoesFuturas,
      dadosAtualizados: diasDesatualizados === 0,
      syncIntervalMinutes: 30,
      nextScheduledSync: _ss.nextScheduledSync || null
    });
  } catch (error) {
    console.error('Erro ao obter status de sync:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// NFSE-M06 onda 5C passo 2: sync manual só faz sentido no master (quem tem
// o motor carregado com seus prepared statements próprios). Se um admin
// dispara POST /api/sync/* e ele cai no worker, o engine do worker estava
// ligado e tudo "funcionava" — mas o estado in-memory do worker ficava
// divergente do master, que continuava rodando sync a cada 5min em paralelo,
// dobrando tráfego para o PNCP. Gate explícito: worker retorna 503 com
// orientação ao admin; master executa normalmente.
function _rejeitaSyncNoWorker(res) {
  return res.status(503).json({
    success: false,
    error: 'Sincronização manual indisponível no worker HTTP. O master executa sync incremental a cada 5min automaticamente; para forçar agora, reinicie o serviço liciteagora (master).'
  });
}

/**
 * Endpoint para iniciar sincronização completa
 */
app.post('/api/sync/full', (req, res) => {
  if ((process.env.ROLE || 'master') !== 'master') return _rejeitaSyncNoWorker(res);
  const { diasAtras = 30, diasFrente = 7 } = req.body || {};

  if (pncpSync.isRunning()) {
    return res.json({ success: false, message: 'Sincronização já em andamento', status: pncpSync.getSyncStatus() });
  }

  pncpSync.sincronizarCompleta(diasAtras, diasFrente);
  res.json({ success: true, message: 'Sincronização completa iniciada', status: pncpSync.getSyncStatus() });
});

/**
 * Endpoint para iniciar sincronização incremental
 */
app.post('/api/sync/incremental', (req, res) => {
  if ((process.env.ROLE || 'master') !== 'master') return _rejeitaSyncNoWorker(res);

  if (pncpSync.isRunning()) {
    return res.json({ success: false, message: 'Sincronização já em andamento', status: pncpSync.getSyncStatus() });
  }

  pncpSync.sincronizarIncremental();
  res.json({ success: true, message: 'Sincronização incremental iniciada', status: pncpSync.getSyncStatus() });
});

/**
 * Endpoint legado (mantido para compatibilidade)
 */
app.post('/api/sync/start', (req, res) => {
  if ((process.env.ROLE || 'master') !== 'master') return _rejeitaSyncNoWorker(res);
  const { diasAtras = 30, diasFrente = 7 } = req.body || {};

  if (pncpSync.isRunning()) {
    return res.json({ success: false, message: 'Sincronização já em andamento', status: pncpSync.getSyncStatus() });
  }

  // Se já tem dados, faz incremental; senão, faz completa
  const stats = db.prepare('SELECT COUNT(*) as count FROM licitacoes').get();
  if (stats.count > 0) {
    pncpSync.sincronizarIncremental();
    res.json({ success: true, message: 'Sincronização incremental iniciada', status: pncpSync.getSyncStatus() });
  } else {
    pncpSync.sincronizarCompleta(diasAtras, diasFrente);
    res.json({ success: true, message: 'Sincronização completa iniciada', status: pncpSync.getSyncStatus() });
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

/**
 * Endpoint para salvar interesse em itens
 */
app.post('/api/interesse', (req, res) => {
  try {
    const { cnpj, ano, sequencial, itens, grupoId } = req.body;

    if (!cnpj || !ano || !sequencial || !itens || !Array.isArray(itens)) {
      return res.status(400).json({
        success: false,
        error: 'Dados incompletos. Necessario: cnpj, ano, sequencial, itens[]'
      });
    }

    const insertInteresse = db.prepare(`
      INSERT OR REPLACE INTO interesse (cnpj, ano, sequencial, numeroItem, grupoId, dataCriacao)
      VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `);

    // Adicionar automaticamente ao Kanban
    const insertKanban = db.prepare(`
      INSERT OR IGNORE INTO kanban_status (cnpj, ano, sequencial, status, dataAtualizacao)
      VALUES (?, ?, ?, 'analise', CURRENT_TIMESTAMP)
    `);

    const parsedGrupoId = grupoId ? parseInt(grupoId) : null;

    const transaction = db.transaction(() => {
      for (const numeroItem of itens) {
        insertInteresse.run(cnpj, ano, sequencial, numeroItem, parsedGrupoId);
      }
      // Adiciona ao kanban (ignora se já existir)
      insertKanban.run(cnpj, ano, sequencial);
    });
    transaction();

    res.json({
      success: true,
      message: itens.length + ' item(s) salvo(s) com interesse',
      data: { cnpj, ano, sequencial, itens }
    });

  } catch (error) {
    console.error('Erro ao salvar interesse:', error.message);
    res.status(500).json({
      success: false,
      error: 'Erro ao salvar interesse',
      details: error.message
    });
  }
});

/**
 * Endpoint para listar itens de interesse com detalhes
 */
app.get('/api/interesse', (req, res) => {
  try {
    const { cnpj, ano, sequencial } = req.query;

    let sql = `
      SELECT
        i.id,
        i.cnpj,
        i.ano,
        i.sequencial,
        i.numeroItem,
        i.dataCriacao,
        i.grupoId,
        g.nome as grupoNome,
        l.objetoCompra,
        l.razaoSocial as nomeOrgao,
        l.codigoUnidade as codigoUnidadeCompradora,
        l.valorTotalEstimado as valorTotalLicitacao,
        l.dataAberturaProposta,
        l.dataEncerramentoProposta,
        l.linkSistemaOrigem,
        l.modalidadeNome,
        l.numeroCompra,
        it.descricao,
        it.quantidade,
        it.unidadeMedida,
        it.valorUnitarioEstimado,
        it.valorTotal
      FROM interesse i
      LEFT JOIN grupos_palavras g ON g.id = i.grupoId
      LEFT JOIN licitacoes l ON i.cnpj = l.cnpj AND i.ano = l.anoCompra AND i.sequencial = l.sequencialCompra
      LEFT JOIN itens it ON l.id = it.licitacaoId AND i.numeroItem = it.numeroItem
    `;
    let params = [];

    if (cnpj && ano && sequencial) {
      sql += ' WHERE i.cnpj = ? AND i.ano = ? AND i.sequencial = ?';
      params = [cnpj, ano, sequencial];
    }

    sql += ' ORDER BY l.dataAberturaProposta ASC, i.dataCriacao DESC';

    const interesses = db.prepare(sql).all(...params);

    res.json({
      success: true,
      data: interesses
    });

  } catch (error) {
    console.error('Erro ao listar interesse:', error.message);
    res.status(500).json({
      success: false,
      error: 'Erro ao listar interesse',
      details: error.message
    });
  }
});

/**
 * Endpoint para remover interesse
 */
app.delete('/api/interesse/:id', (req, res) => {
  try {
    const { id } = req.params;

    const result = db.prepare('DELETE FROM interesse WHERE id = ?').run(id);

    if (result.changes > 0) {
      res.json({ success: true, message: 'Interesse removido' });
    } else {
      res.status(404).json({ success: false, error: 'Interesse nao encontrado' });
    }

  } catch (error) {
    console.error('Erro ao remover interesse:', error.message);
    res.status(500).json({
      success: false,
      error: 'Erro ao remover interesse',
      details: error.message
    });
  }
});

/**
 * Endpoint para remover TODOS os interesses
 */
app.delete('/api/interesse', (req, res) => {
  try {
    const result = db.prepare('DELETE FROM interesse').run();

    res.json({
      success: true,
      message: `${result.changes} interesse(s) removido(s)`,
      removidos: result.changes
    });

  } catch (error) {
    console.error('Erro ao remover todos interesses:', error.message);
    res.status(500).json({
      success: false,
      error: 'Erro ao remover interesses',
      details: error.message
    });
  }
});

/**
 * Endpoints para valores de proposta (persistência)
 */

// Salvar valores de um item da proposta
app.post('/api/valores-proposta', (req, res) => {
  try {
    const { cnpj, ano, sequencial, numeroItem, valorUnitario, marca, modelo, fabricante, selecionado } = req.body;

    if (!cnpj || !ano || !sequencial || numeroItem === undefined) {
      return res.status(400).json({
        success: false,
        error: 'Dados incompletos. Necessário: cnpj, ano, sequencial, numeroItem'
      });
    }

    const stmt = db.prepare(`
      INSERT OR REPLACE INTO valores_proposta
      (cnpj, ano, sequencial, numeroItem, valorUnitario, marca, modelo, fabricante, selecionado, dataAtualizacao)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `);

    stmt.run(cnpj, ano, sequencial, numeroItem, valorUnitario || null, marca || '', modelo || '', fabricante || '', selecionado ? 1 : 0);

    res.json({
      success: true,
      message: 'Valor da proposta salvo'
    });

  } catch (error) {
    console.error('Erro ao salvar valor da proposta:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Salvar valores de múltiplos itens de uma vez
app.post('/api/valores-proposta/batch', (req, res) => {
  try {
    const { cnpj, ano, sequencial, itens } = req.body;

    if (!cnpj || !ano || !sequencial || !itens || !Array.isArray(itens)) {
      return res.status(400).json({
        success: false,
        error: 'Dados incompletos. Necessário: cnpj, ano, sequencial, itens[]'
      });
    }

    const stmt = db.prepare(`
      INSERT OR REPLACE INTO valores_proposta
      (cnpj, ano, sequencial, numeroItem, valorUnitario, marca, modelo, fabricante, selecionado, dataAtualizacao)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `);

    const transaction = db.transaction(() => {
      for (const item of itens) {
        stmt.run(
          cnpj, ano, sequencial, item.numeroItem,
          item.valorUnitario || null,
          item.marca || '',
          item.modelo || '',
          item.fabricante || '',
          item.selecionado ? 1 : 0
        );
      }
    });
    transaction();

    res.json({
      success: true,
      message: `${itens.length} valor(es) salvo(s)`
    });

  } catch (error) {
    console.error('Erro ao salvar valores da proposta:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Buscar valores de proposta de uma licitação
app.get('/api/valores-proposta/:cnpj/:ano/:sequencial', (req, res) => {
  try {
    const { cnpj, ano, sequencial } = req.params;

    const valores = db.prepare(`
      SELECT numeroItem, valorUnitario, marca, modelo, fabricante, selecionado
      FROM valores_proposta
      WHERE cnpj = ? AND ano = ? AND sequencial = ?
    `).all(cnpj, ano, sequencial);

    // Converter para objeto indexado por numeroItem
    const valoresObj = {};
    for (const v of valores) {
      valoresObj[v.numeroItem] = {
        valorUnitario: v.valorUnitario,
        marca: v.marca || '',
        modelo: v.modelo || '',
        fabricante: v.fabricante || '',
        selecionado: v.selecionado === 1
      };
    }

    res.json({
      success: true,
      valores: valoresObj
    });

  } catch (error) {
    console.error('Erro ao buscar valores da proposta:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Deletar valores de proposta de uma licitação
app.delete('/api/valores-proposta/:cnpj/:ano/:sequencial', (req, res) => {
  try {
    const { cnpj, ano, sequencial } = req.params;

    const result = db.prepare(`
      DELETE FROM valores_proposta
      WHERE cnpj = ? AND ano = ? AND sequencial = ?
    `).run(cnpj, ano, sequencial);

    res.json({
      success: true,
      message: `${result.changes} valor(es) removido(s)`
    });

  } catch (error) {
    console.error('Erro ao remover valores da proposta:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Endpoint para propostas pendentes (usado pela extensao)
 */
app.get('/api/comprasnet/propostas-pendentes', (req, res) => {
  try {
    // Busca licitacoes que estao prontas para enviar proposta
    const sql = `
      SELECT DISTINCT
        k.cnpj, k.ano, k.sequencial,
        l.objetoCompra,
        l.codigoUnidade as uasg,
        l.linkSistemaOrigem,
        vp.numeroItem as numero,
        vp.valor
      FROM kanban_status k
      JOIN licitacoes l ON k.cnpj = l.cnpj AND k.ano = l.anoCompra AND k.sequencial = l.sequencialCompra
      JOIN valores_proposta vp ON k.cnpj = vp.cnpj AND k.ano = vp.ano AND k.sequencial = vp.sequencial
      WHERE k.status = 'pronto'
      ORDER BY l.dataEncerramentoProposta ASC
      LIMIT 10
    `;

    const rows = db.prepare(sql).all();

    // Agrupa por licitacao
    const licitacoes = {};
    for (const row of rows) {
      const key = row.cnpj + '-' + row.ano + '-' + row.sequencial;
      if (!licitacoes[key]) {
        licitacoes[key] = {
          cnpj: row.cnpj,
          ano: row.ano,
          sequencial: row.sequencial,
          uasg: row.uasg,
          objetoCompra: row.objetoCompra,
          linkSistemaOrigem: row.linkSistemaOrigem,
          itens: []
        };
      }
      licitacoes[key].itens.push({
        numero: row.numero,
        valor: row.valor
      });
    }

    res.json(Object.values(licitacoes));
  } catch (error) {
    console.error('Erro ao buscar propostas pendentes:', error.message);
    res.json([]);
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

// ==================== MONITORAMENTO DE CHAT ====================

// Iniciar monitoramento de chat de uma licitação
app.post('/api/chat/monitorar', (req, res) => {
  try {
    const { cnpj, ano, sequencial } = req.body;

    if (!cnpj || !ano || !sequencial) {
      return res.status(400).json({ success: false, error: 'Dados incompletos' });
    }

    db.prepare(`
      INSERT OR REPLACE INTO chat_monitoramento (cnpj, ano, sequencial, ativo, dataCriacao)
      VALUES (?, ?, ?, 1, CURRENT_TIMESTAMP)
    `).run(cnpj, ano, sequencial);

    res.json({ success: true, message: 'Monitoramento ativado' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Registro automático de licitação acessada (chamado pela extensão)
app.post('/api/chat/monitoramento/registrar', (req, res) => {
  try {
    const { cnpj, ano, sequencial, compraId, url } = req.body;

    if (!compraId && (!cnpj || !ano || !sequencial)) {
      return res.status(400).json({ success: false, error: 'Precisa de compraId ou cnpj/ano/sequencial' });
    }

    // Registro por compraId → direto em participacoes_comprasnet (tabela do polling)
    if (compraId) {
      const existente = db.prepare('SELECT id, cnpj, urlCompra FROM participacoes_comprasnet WHERE compraId = ?').get(compraId);
      if (existente) {
        // Atualiza campos que estavam vazios + marca ativo
        db.prepare(`UPDATE participacoes_comprasnet SET
          cnpj = CASE WHEN cnpj IS NULL OR cnpj = '' THEN ? ELSE cnpj END,
          ano = CASE WHEN ano IS NULL OR ano = 0 THEN ? ELSE ano END,
          sequencial = CASE WHEN sequencial IS NULL OR sequencial = 0 THEN ? ELSE sequencial END,
          urlCompra = CASE WHEN urlCompra IS NULL OR urlCompra = '' OR urlCompra NOT LIKE '%acompanhamento-compra%' THEN ? ELSE urlCompra END,
          dataAtualizacao = CURRENT_TIMESTAMP, ativo = 1
          WHERE compraId = ?`).run(cnpj || '', ano || 0, sequencial || 0, url || '', compraId);
        return res.json({ success: true, novo: false, message: 'Já monitorado' });
      }

      db.prepare(`
        INSERT INTO participacoes_comprasnet
          (compraId, cnpj, codigoUnidade, ano, sequencial, tipo, numero, orgao, objeto, etapa, situacao, urlCompra, dataSessao, ativo, dataAtualizacao)
        VALUES (?, ?, '', ?, ?, '', '', '', '', '', '', ?, '', 1, CURRENT_TIMESTAMP)
      `).run(compraId, cnpj || '', ano || 0, sequencial || 0, url || '');

      console.log(`[Auto-Monitor] Registrado: compraId=${compraId}`);
      return res.json({ success: true, novo: true, message: 'Registrado para monitoramento' });
    }

    // Fallback: registro por cnpj/ano/sequencial
    const existente = db.prepare('SELECT id FROM chat_monitoramento WHERE cnpj = ? AND ano = ? AND sequencial = ?')
      .get(cnpj, ano, sequencial);

    if (existente) {
      return res.json({ success: true, novo: false, message: 'Já monitorado' });
    }

    db.prepare(`
      INSERT INTO chat_monitoramento (cnpj, ano, sequencial, ativo, dataCriacao)
      VALUES (?, ?, ?, 1, CURRENT_TIMESTAMP)
    `).run(cnpj, ano, sequencial);

    console.log(`[Auto-Monitor] Registrado: ${cnpj}/${ano}/${sequencial}`);
    res.json({ success: true, novo: true, message: 'Registrado para monitoramento' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Desativar monitoramento por compraId
app.post('/api/chat/monitoramento/desativar/:compraId', (req, res) => {
  try {
    const { compraId } = req.params;
    db.prepare('UPDATE participacoes_comprasnet SET ativo = 0 WHERE compraId = ?').run(compraId);
    res.json({ success: true, message: 'Monitoramento desativado' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Parar monitoramento
app.delete('/api/chat/monitorar/:cnpj/:ano/:sequencial', (req, res) => {
  try {
    const { cnpj, ano, sequencial } = req.params;

    db.prepare('UPDATE chat_monitoramento SET ativo = 0 WHERE cnpj = ? AND ano = ? AND sequencial = ?')
      .run(cnpj, ano, sequencial);

    res.json({ success: true, message: 'Monitoramento desativado' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== SINCRONIZAÇÃO DE PARTICIPAÇÕES ====================

// Receber participações do Comprasnet (chamado pela extensão)
app.post('/api/chat/participacoes/sincronizar', (req, res) => {
  try {
    const { participacoes } = req.body;

    if (!participacoes || !Array.isArray(participacoes)) {
      return res.status(400).json({ success: false, error: 'Participações inválidas' });
    }

    console.log(`[Participações] Recebendo ${participacoes.length} participações para sincronizar`);

    let inseridas = 0;
    let atualizadas = 0;

    const insertStmt = db.prepare(`
      INSERT INTO participacoes_comprasnet
        (compraId, cnpj, codigoUnidade, ano, sequencial, tipo, numero, orgao, objeto, etapa, situacao, urlCompra, dataSessao, ativo, dataAtualizacao)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
      ON CONFLICT(compraId) DO UPDATE SET
        etapa = excluded.etapa,
        situacao = excluded.situacao,
        objeto = COALESCE(excluded.objeto, objeto),
        dataAtualizacao = CURRENT_TIMESTAMP,
        ativo = 1
    `);

    for (const p of participacoes) {
      try {
        // Monta o compraId se não vier
        const compraId = p.compraId || `${p.codigoUnidade || p.cnpj}${String(p.sequencial || p.numero).padStart(5, '0')}${p.ano}`;

        const result = insertStmt.run(
          compraId,
          p.cnpj || p.cnpjOrgao || '',
          p.codigoUnidade || p.uasg || '',
          p.ano || 0,
          p.sequencial || p.numero || 0,
          p.tipo || '',
          p.numero || p.sequencial || '',
          p.orgao || p.nomeOrgao || '',
          p.objeto || p.objetoCompra || '',
          p.etapa || '',
          p.situacao || p.status || '',
          p.urlCompra || p.url || '',
          p.dataSessao || ''
        );

        if (result.changes > 0) {
          if (result.lastInsertRowid) {
            inseridas++;
          } else {
            atualizadas++;
          }
        }
      } catch (e) {
        console.log(`[Participações] Erro ao inserir: ${e.message}`);
      }
    }

    console.log(`[Participações] Sincronização concluída: ${inseridas} novas, ${atualizadas} atualizadas`);
    res.json({
      success: true,
      inseridas,
      atualizadas,
      total: participacoes.length
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Listar monitoramentos ativos (participações do Comprasnet)
app.get('/api/chat/monitoramentos', (req, res) => {
  try {
    // Busca licitações para polling da tabela participacoes_comprasnet
    const monitoramentos = db.prepare(`
      SELECT compraId, cnpj, codigoUnidade, ano, sequencial, tipo, numero,
             orgao as nomeOrgao, objeto as objetoCompra, etapa, situacao, urlCompra, dataSessao
      FROM participacoes_comprasnet
      WHERE ativo = 1 AND compraId IS NOT NULL AND compraId != ''
      ORDER BY dataAtualizacao DESC
    `).all();

    res.json({ success: true, data: monitoramentos });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Registrar nova mensagem do chat (será chamado pelo robô)
app.post('/api/chat/mensagem', async (req, res) => {
  try {
    const { cnpj, ano, sequencial, mensagemId, remetente, conteudo, dataHora } = req.body;

    // Verificar se mensagem já existe
    const existe = db.prepare('SELECT id FROM chat_mensagens WHERE cnpj = ? AND ano = ? AND sequencial = ? AND mensagemId = ?')
      .get(cnpj, ano, sequencial, mensagemId);

    if (existe) {
      return res.json({ success: true, message: 'Mensagem já registrada' });
    }

    // Salvar mensagem
    db.prepare(`
      INSERT INTO chat_mensagens (cnpj, ano, sequencial, mensagemId, remetente, conteudo, dataHora)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(cnpj, ano, sequencial, mensagemId, remetente, conteudo, dataHora);

    // Buscar informações da licitação
    const licitacao = db.prepare('SELECT objetoCompra, razaoSocial FROM licitacoes WHERE cnpj = ? AND anoCompra = ? AND sequencialCompra = ?')
      .get(cnpj, ano, sequencial);

    // Enviar alerta no Telegram
    const mensagemTelegram = `🔔 <b>NOVA MENSAGEM NO CHAT</b>\n\n` +
      `<b>Licitação:</b> ${licitacao?.objetoCompra?.substring(0, 100) || 'N/A'}...\n` +
      `<b>Órgão:</b> ${licitacao?.razaoSocial || 'N/A'}\n\n` +
      `<b>De:</b> ${remetente}\n` +
      `<b>Mensagem:</b>\n${conteudo}\n\n` +
      `<i>${dataHora}</i>`;

    const enviado = await enviarTelegram(mensagemTelegram);

    // Marcar como notificado
    if (enviado) {
      db.prepare('UPDATE chat_mensagens SET notificado = 1 WHERE cnpj = ? AND ano = ? AND sequencial = ? AND mensagemId = ?')
        .run(cnpj, ano, sequencial, mensagemId);
    }

    res.json({ success: true, notificado: enviado });
  } catch (error) {
    console.error('Erro ao registrar mensagem:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});


// ==================== ROBÔ DE MONITORAMENTO DE MENSAGENS DO COMPRASNET ====================

// Instância única do monitor de mensagens

// Classe para monitorar TODAS as mensagens do Comprasnet (área de comunicados)
class MonitorMensagensComprasnet {
  constructor() {
    this.browser = null;
    this.page = null;
    this.ativo = false;
    this.intervalo = null;
    this.mensagensProcessadas = new Set();
    this.logs = [];
    this.ultimaVerificacao = null;
    this.totalMensagensNovas = 0;
  }

  log(mensagem) {
    const timestamp = new Date().toLocaleTimeString('pt-BR');
    const logEntry = `[${timestamp}] ${mensagem}`;
    this.logs.push(logEntry);
    console.log(`[Monitor Mensagens] ${mensagem}`);
    if (this.logs.length > 100) this.logs.shift();
  }

  async iniciar() {
    if (this.ativo) {
      this.log('Monitor já está ativo');
      return { success: true, message: 'Já está ativo' };
    }

    try {
      this.log('Iniciando monitoramento de mensagens do Comprasnet...');

      // Verificar modo de login manual
      const loginManual = getConfigValue('chat_login_manual') === '1';
      if (loginManual) {
        this.log('Modo de LOGIN MANUAL ativado');
      }

      // Verificar se há certificado digital configurado (prioridade)
      const cert = db.prepare('SELECT certificadoBase64, senhaCriptografada, titular FROM certificado_digital WHERE id = 1').get();
      const usarCertificado = !!cert && !!cert.certificadoBase64;

      // Buscar credenciais CPF/senha como fallback
      const cpf = getConfigValue('govbr_cpf');
      const senha = getConfigValue('govbr_senha');

      // No modo manual, não exigir credenciais
      if (!loginManual && !usarCertificado && (!cpf || !senha)) {
        throw new Error('Configure o certificado digital OU as credenciais gov.br em Configurações > Dados do Fornecedor');
      }

      this.loginManual = loginManual;

      // Preparar certificado se disponível
      let certInstalado = false;
      if (usarCertificado) {
        this.log('Certificado digital encontrado - usando login com certificado');
        const os = require('os');
        const fs = require('fs');
        const { execSync } = require('child_process');

        const certTempPath = path.join(os.tmpdir(), `cert_${Date.now()}.pfx`);
        const certBuffer = Buffer.from(cert.certificadoBase64, 'base64');
        const certSenha = Buffer.from(cert.senhaCriptografada, 'base64').toString();
        fs.writeFileSync(certTempPath, certBuffer);
        this.log('Certificado salvo em arquivo temporário');

        // Verificar se o certificado já está instalado no Windows
        try {
          const result = execSync('certutil -store -user My', { encoding: 'utf8', stdio: 'pipe' });
          if (cert.titular && result.includes(cert.titular.split(':')[0])) {
            certInstalado = true;
            this.log('Certificado já está instalado no Windows');
          }
        } catch (e) {}

        // Tentar instalar certificado
        if (!certInstalado) {
          try {
            execSync(`certutil -f -p "${certSenha}" -user -importpfx "${certTempPath}"`, { stdio: 'pipe' });
            this.log('Certificado instalado no Windows Certificate Store');
            certInstalado = true;
          } catch (e) {
            this.log('Aviso: Não foi possível instalar certificado automaticamente');
          }
        }

        // Limpar arquivo temporário
        try { fs.unlinkSync(certTempPath); } catch (e) {}
      }

      // Flag para saber qual método de login usar
      this.usarCertificado = usarCertificado && certInstalado;
      this.cpf = cpf;
      this.senhaGovbr = senha;

      if (this.usarCertificado) {
        this.log('Login será feito com certificado digital');
      } else if (cpf && senha) {
        this.log('Login será feito com CPF/senha');
      } else {
        throw new Error('Nenhum método de autenticação disponível');
      }

      // Configurar argumentos do navegador
      const browserArgs = [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process',
        '--ignore-certificate-errors',
        '--ignore-ssl-errors=true',
        '--ignore-certificate-errors-spki-list',
        '--allow-running-insecure-content',
        '--disable-blink-features=AutomationControlled',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--window-size=1366,768',
        '--disable-extensions',
        '--disable-popup-blocking'
      ];

      // Auto-selecionar certificado para gov.br
      if (this.usarCertificado) {
        browserArgs.push('--auto-select-certificate-for-urls={"pattern":"*gov.br*","filter":{}}');
      }

      // Verificar proxy
      const proxyAtivo = getConfigValue('proxy_ativo');
      const proxyServidor = getConfigValue('proxy_servidor');
      const proxyPorta = getConfigValue('proxy_porta');

      if (proxyAtivo === '1' && proxyServidor && proxyPorta) {
        browserArgs.push(`--proxy-server=${proxyServidor}:${proxyPorta}`);
        this.log(`Usando proxy: ${proxyServidor}:${proxyPorta}`);
      }

      // NOVA ABORDAGEM: Conectar a um Chrome já aberto pelo usuário
      // Isso evita problemas de detecção do reCaptcha
      const os = require('os');
      const userDataDir = path.join(os.homedir(), '.pncp-monitor-data');
      const chromeExecutable = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
      const debuggingPort = 9222;

      // Tentar conectar a um Chrome já aberto
      let conectadoAoExistente = false;
      try {
        this.log(`Tentando conectar ao Chrome existente na porta ${debuggingPort}...`);
        const response = await axios.get(`http://127.0.0.1:${debuggingPort}/json/version`, { timeout: 2000 });
        const wsEndpoint = response.data.webSocketDebuggerUrl;

        this.browser = await puppeteer.connect({
          browserWSEndpoint: wsEndpoint,
          defaultViewport: null
        });

        this.log(`✅ Conectado ao Chrome existente!`);
        conectadoAoExistente = true;

        // Buscar a aba correta do cnetmobile (onde está logado)
        const pages = await this.browser.pages();
        this.log(`Abas abertas: ${pages.length}`);

        // Priorizar aba do cnetmobile que não seja acesso-nao-autorizado
        for (const p of pages) {
          const url = p.url();
          this.log(`  Aba: ${url.substring(0, 80)}...`);
        }

        // Primeiro tentar encontrar aba do cnetmobile logada
        this.page = pages.find(p => {
          const url = p.url();
          return url.includes('cnetmobile') &&
                 !url.includes('acesso-nao-autorizado') &&
                 (url.includes('/compras') || url.includes('/fornecedor'));
        });

        // Se não encontrou, tentar qualquer aba do cnetmobile
        if (!this.page) {
          this.page = pages.find(p => p.url().includes('cnetmobile') && !p.url().includes('acesso-nao-autorizado'));
        }

        // Se ainda não encontrou, usar a primeira aba válida
        if (!this.page) {
          this.page = pages.find(p => !p.url().includes('about:blank')) || pages[0];
        }

        if (!this.page) {
          this.page = await this.browser.newPage();
        }

        this.log(`Usando aba: ${this.page.url().substring(0, 80)}`);

      } catch (e) {
        // Chrome não está rodando com depuração - iniciar novo
        this.log(`Chrome não encontrado na porta ${debuggingPort}, iniciando novo...`);
        this.log(`⚠️ IMPORTANTE: Faça login MANUALMENTE no gov.br e depois reinicie o servidor!`);

        // Adicionar porta de depuração
        browserArgs.push(`--remote-debugging-port=${debuggingPort}`);

        this.browser = await puppeteer.launch({
          headless: false,
          defaultViewport: null,
          args: browserArgs,
          userDataDir: userDataDir,
          executablePath: chromeExecutable,
          ignoreDefaultArgs: ['--enable-automation', '--enable-blink-features=IdleDetection']
        });

        this.log(`Chrome iniciado com depuração na porta ${debuggingPort}`);
        this.log(`Usando diretório de dados do navegador: ${userDataDir}`);

        this.page = await this.browser.newPage();
      }

      this.page.setDefaultTimeout(120000);

      // Ignorar erros de SSL/certificado
      try {
        await this.page.setBypassCSP(true);
        const client = await this.page.target().createCDPSession();
        await client.send('Security.enable');
        await client.send('Security.setIgnoreCertificateErrors', { ignore: true });
      } catch (e) {
        // Ignorar erros ao configurar
      }

      // Autenticar proxy se necessário
      const proxyUsuario = getConfigValue('proxy_usuario');
      const proxySenha = getConfigValue('proxy_senha');
      if (proxyAtivo === '1' && proxyUsuario && proxySenha) {
        await this.page.authenticate({ username: proxyUsuario, password: proxySenha });
      }

      // Se conectou a Chrome existente, verificar se já está logado
      let jaLogado = false;
      if (conectadoAoExistente) {
        const url = this.page.url();
        if (url.includes('cnetmobile') && !url.includes('acesso-nao-autorizado')) {
          this.log(`✅ Já está logado no cnetmobile!`);
          jaLogado = true;
        } else if (url.includes('comprasnet') && !url.includes('login')) {
          this.log(`✅ Já está logado no comprasnet!`);
          jaLogado = true;
        }
      }

      // Fazer login apenas se necessário
      if (!jaLogado) {
        await this.fazerLogin();
      }

      // Ir para área de mensagens do Comprasnet
      await this.irParaMensagens();

      this.ativo = true;
      this.log('Monitoramento iniciado com sucesso!');

      // Notificar no Telegram
      await enviarTelegram('🟢 <b>Monitor de Mensagens Ativo</b>\n\nMonitorando comunicações de pregoeiros no Comprasnet.');

      // Iniciar loop de verificação
      this.iniciarVerificacao();

      return { success: true };
    } catch (error) {
      this.log('Erro ao iniciar: ' + error.message);
      await this.parar();
      throw error;
    }
  }

  async fazerLogin() {
    // IMPORTANTE: O fluxo correto é acessar primeiro o Comprasnet, que redireciona para gov.br
    // Após login no gov.br, ele redireciona de volta ao Comprasnet com a sessão autenticada

    this.log('Verificando sessão existente...');

    // Primeiro, tentar acessar área segura do Comprasnet antigo para verificar sessão
    try {
      await this.page.goto('https://www.comprasnet.gov.br/seguro/indexgov.asp', { waitUntil: 'networkidle2', timeout: 30000 });
      await new Promise(r => setTimeout(r, 3000));

      let urlAtual = this.page.url();
      this.log(`URL ao verificar sessão (antigo): ${urlAtual}`);

      // Se conseguiu acessar área segura sem redirecionamento para login, já está logado
      if (urlAtual.includes('comprasnet.gov.br/seguro') && !urlAtual.includes('login')) {
        this.log('Sessão existente válida encontrada no Comprasnet ANTIGO!');
        this.portalAntigo = true;
        return; // Já está logado
      }
    } catch (e) {
      this.log('Comprasnet antigo: erro ou sem sessão');
    }

    // Tentar também o Comprasnet novo
    try {
      await this.page.goto('https://cnetmobile.estaleiro.serpro.gov.br/comprasnet-web/seguro/fornecedor/', { waitUntil: 'networkidle2', timeout: 30000 });
      await new Promise(r => setTimeout(r, 3000));

      let urlAtual = this.page.url();
      this.log(`URL ao verificar sessão (novo): ${urlAtual}`);

      if (urlAtual.includes('seguro/fornecedor') && !urlAtual.includes('acesso-nao-autorizado')) {
        this.log('Sessão existente válida encontrada no Comprasnet NOVO!');
        this.portalAntigo = false;
        return; // Já está logado
      }
    } catch (e) {
      this.log('Comprasnet novo: erro ou sem sessão');
    }

    this.log('Nenhuma sessão válida encontrada, iniciando login...');

    // MODO MANUAL: Aguardar usuário fazer login manualmente
    if (this.loginManual) {
      this.log('🖐️ MODO MANUAL: Faça login e navegue até o CNETMOBILE');
      this.log('Aguardando login manual (máximo 5 minutos)...');
      this.log('IMPORTANTE: Após login, clique em "Compras" e acesse uma licitação no sistema novo!');

      // Notificar via Telegram
      await enviarTelegram('🖐️ <b>Login Manual Necessário</b>\n\nO navegador foi aberto para você fazer login.\n\n<b>IMPORTANTE:</b> Após login, navegue até o sistema novo (cnetmobile):\n1. Clique em "Compras"\n2. Acesse uma licitação\n\nTempo limite: 5 minutos');

      // Ir diretamente para a página de login do fornecedor
      this.log('Abrindo página de login do Compras.gov.br...');
      try {
        // Acessar diretamente a página de login do fornecedor
        // URL baseada na foto 1 das evidências
        await this.page.goto('https://compras.gov.br/acesso-ao-sistema', { waitUntil: 'networkidle2', timeout: 60000 }).catch(async () => {
          // Se não existir, tentar comprasnet.gov.br
          await this.page.goto('https://www.comprasnet.gov.br/seguro/loginPortal.asp', { waitUntil: 'networkidle2', timeout: 60000 });
        });

        await new Promise(r => setTimeout(r, 3000));

        // Verificar URL atual
        let urlAtual = this.page.url();
        this.log(`URL após carregar: ${urlAtual}`);

        // Se ainda não está na página de login SSO, tentar navegar para login do fornecedor
        if (!urlAtual.includes('sso.acesso.gov.br') && !urlAtual.includes('cnetmobile')) {
          // Tentar clicar em "Fornecedor Brasileiro" se estiver visível
          const clicouFornecedor = await this.page.evaluate(() => {
            const elementos = Array.from(document.querySelectorAll('a, button, div, span'));
            for (const el of elementos) {
              const texto = (el.textContent || '').toLowerCase();
              if (texto.includes('fornecedor brasileiro') || texto.includes('fornecedor') && texto.includes('brasileiro')) {
                el.click();
                return { clicked: true, text: texto.substring(0, 50) };
              }
            }
            // Tentar "Acesso ao Sistema"
            for (const el of elementos) {
              const texto = (el.textContent || '').trim().toLowerCase();
              if (texto === 'acesso ao sistema' || (texto.includes('acesso') && texto.includes('sistema'))) {
                el.click();
                return { clicked: true, text: 'Acesso ao Sistema' };
              }
            }
            return { clicked: false };
          });

          if (clicouFornecedor.clicked) {
            this.log(`Clicou em: ${clicouFornecedor.text}`);
            await new Promise(r => setTimeout(r, 3000));
          }

          // Verificar se apareceu modal de login
          urlAtual = this.page.url();
          if (!urlAtual.includes('sso.acesso.gov.br')) {
            // Tentar clicar em "Entrar com Gov.br"
            await this.page.evaluate(() => {
              const elementos = Array.from(document.querySelectorAll('a, button, div'));
              for (const el of elementos) {
                const texto = (el.textContent || '').toLowerCase();
                if (texto.includes('gov.br') || texto.includes('entrar')) {
                  el.click();
                  return true;
                }
              }
              return false;
            });
            await new Promise(r => setTimeout(r, 3000));
          }
        }
      } catch (e) {
        this.log('Erro ao acessar Compras.gov.br: ' + e.message);
        this.log('Tentando comprasnet.gov.br como fallback...');
        await this.page.goto('https://www.comprasnet.gov.br/seguro/loginPortal.asp', { waitUntil: 'networkidle2', timeout: 60000 });
      }
      await new Promise(r => setTimeout(r, 2000));

      this.log('Página de login aberta - faça login com certificado ou CPF/senha');

      // Aguardar até 5 minutos para login manual
      let loginSucesso = false;
      this.avisouCnetmobile = false; // Flag para avisar apenas uma vez
      for (let i = 0; i < 60; i++) { // 60 x 5s = 5 minutos
        await new Promise(r => setTimeout(r, 5000));

        // Verificar todas as abas/páginas do navegador (login pode abrir nova aba)
        const pages = await this.browser.pages();
        let url = this.page.url();

        // Logar todas as URLs das abas a cada 30 segundos para debug
        if (i % 6 === 0) {
          this.log(`Abas abertas: ${pages.length}`);
          for (let p = 0; p < pages.length; p++) {
            const pageUrl = pages[p].url();
            this.log(`  Aba ${p}: ${pageUrl.substring(0, 100)}`);
          }
        }

        // Procurar em todas as abas por uma que indique login bem-sucedido
        for (const page of pages) {
          const pageUrl = page.url();
          // Verificar várias URLs possíveis após login
          const isLoginPage =
              pageUrl.includes('comprasnet.gov.br/intro') ||
              pageUrl.includes('comprasnet.gov.br/Fornecedor') ||
              pageUrl.includes('comprasnet.gov.br/seguro') ||
              pageUrl.includes('compras.gov.br/fornecedor') ||
              pageUrl.includes('Area-Trabalho-do-Fornecedor') ||
              (pageUrl.includes('cnetmobile') && !pageUrl.includes('acesso-nao-autorizado'));

          if (isLoginPage) {
            // Encontrou aba com login - mudar para ela
            this.page = page;
            url = pageUrl;
            this.log(`✅ Detectada aba com login: ${url.substring(0, 80)}...`);
            break;
          }
        }

        this.log(`URL atual: ${url.substring(0, 80)}...`);

        // PRIORIDADE 1: Verificar se há aba do cnetmobile (melhor cenário)
        let temCnetmobile = false;
        for (const page of pages) {
          const pageUrl = page.url();
          if (pageUrl.includes('cnetmobile') && !pageUrl.includes('acesso-nao-autorizado')) {
            this.page = page;
            loginSucesso = true;
            temCnetmobile = true;
            this.log('✅ Login detectado no cnetmobile!');
            break;
          }
        }
        if (temCnetmobile) break;

        // PRIORIDADE 2: Detectar login no comprasnet antigo
        let loginComprasnetAntigo = false;
        if (url.includes('comprasnet.gov.br/intro.htm') ||
            url.includes('comprasnet.gov.br/seguro') ||
            url.includes('comprasnet.gov.br/fornecedor')) {
          loginComprasnetAntigo = true;
        }

        // Se detectou login no comprasnet antigo, avisar para navegar até cnetmobile
        if (loginComprasnetAntigo && !this.avisouCnetmobile) {
          this.log('⚠️ Login OK no Comprasnet antigo - agora navegue até o cnetmobile!');
          this.log('➡️ Clique em "Compras" e acesse uma licitação no sistema novo');
          this.avisouCnetmobile = true;
          await enviarTelegram('⚠️ <b>Login OK - Continue navegando!</b>\n\nLogin detectado no Comprasnet antigo.\n\n<b>Agora navegue até o cnetmobile:</b>\n1. Clique em "Compras"\n2. Acesse uma licitação no sistema novo');
        }

        // Só aceitar login do comprasnet antigo se estiver nos últimos 60 segundos
        if (loginComprasnetAntigo && i >= 48) { // 48 * 5 = 240 segundos = 4 minutos
          loginSucesso = true;
          this.log('Aceitando login do Comprasnet antigo (tempo quase esgotado)');
          break;
        }

        // Mostrar status a cada 30 segundos
        if (i % 6 === 0) {
          this.log(`Aguardando login manual... (${Math.floor((300 - i * 5) / 60)} min restantes)`);
        }
      }

      if (!loginSucesso) {
        throw new Error('Timeout aguardando login manual. Reinicie o monitor e tente novamente.');
      }

      this.log('Login manual detectado com sucesso!');
      await enviarTelegram('✅ <b>Login Detectado</b>\n\nLogin manual realizado com sucesso. Iniciando monitoramento...');

      // Mover navegador para fora da tela para não atrapalhar
      try {
        this.log('Movendo navegador para segundo plano...');
        const pages = await this.browser.pages();
        if (pages.length > 0) {
          // Mover janela para fora da tela visível
          const session = await pages[0].target().createCDPSession();
          const { windowId } = await session.send('Browser.getWindowForTarget');
          await session.send('Browser.setWindowBounds', {
            windowId,
            bounds: { left: -2000, top: -2000, width: 800, height: 600 }
          });
          this.log('✅ Navegador movido para fora da tela - monitoramento em segundo plano');
        }
      } catch (e) {
        this.log('Não foi possível mover janela: ' + e.message);
        // Tentar minimizar via JavaScript
        try {
          await this.page.evaluate(() => {
            window.moveTo(-2000, -2000);
            window.resizeTo(800, 600);
          });
          this.log('✅ Janela movida via JavaScript');
        } catch (e2) {
          this.log('Continuando com janela visível: ' + e2.message);
        }
      }

      // IMPORTANTE: Após login, verificar TODAS as abas para encontrar uma no cnetmobile já logada
      const todasAbas = await this.browser.pages();
      this.log(`Verificando ${todasAbas.length} abas após login...`);

      let abaCnetmobile = null;
      for (const aba of todasAbas) {
        const abaUrl = aba.url();
        this.log(`  Verificando: ${abaUrl.substring(0, 80)}`);
        if (abaUrl.includes('cnetmobile.estaleiro.serpro.gov.br') && !abaUrl.includes('acesso-nao-autorizado')) {
          abaCnetmobile = aba;
          this.log(`✅ Encontrada aba do cnetmobile já logada: ${abaUrl}`);
          break;
        }
      }

      // Se encontrou aba do cnetmobile, usar ela!
      if (abaCnetmobile) {
        this.page = abaCnetmobile;
        await this.page.bringToFront(); // Trazer para frente
        this.log('Usando aba do cnetmobile já logada!');
      } else {
        // Verificar onde estamos após login e navegar para área de licitações
        const urlAtual = this.page.url();
        this.log(`URL após login: ${urlAtual}`);

        // Se já está no cnetmobile na aba atual, ótimo!
        if (urlAtual.includes('cnetmobile.estaleiro.serpro.gov.br') && !urlAtual.includes('acesso-nao-autorizado')) {
          this.log('✅ Já está no cnetmobile com sessão válida!');
        }
        // Precisa navegar para o cnetmobile via menu "Compras"
        this.log('Navegando para área de licitações...');

        try {
          // Se está em compras.gov.br ou comprasnet.gov.br, procurar menu "Compras"
          await new Promise(r => setTimeout(r, 2000));

          const currentUrl = this.page.url();
          this.log(`URL atual para navegação: ${currentUrl}`);

          // A página intro.htm usa frames - verificar se há frames
          const frames = this.page.frames();
          this.log(`Número de frames na página: ${frames.length}`);

          // Listar todos os frames para debug
          for (let i = 0; i < frames.length; i++) {
            const frame = frames[i];
            const frameUrl = frame.url();
            this.log(`Frame ${i}: ${frameUrl.substring(0, 80)}`);
          }

          // Procurar menu "Compras" e fazer hover para abrir submenu
          this.log('Procurando menu "Compras" na barra de navegação...');

          // Usar evaluate para encontrar o elemento por texto (funciona no Puppeteer)
          let menuEncontrado = false;
          let navegouParaCnetmobile = false;

          // Tentar em cada frame
          for (const frame of frames) {
            try {
              const frameUrl = frame.url();

              // Listar todos os links no frame para debug
              const todosLinks = await frame.evaluate(() => {
                return Array.from(document.querySelectorAll('a')).slice(0, 30).map(el => ({
                  text: (el.textContent || el.innerText || '').trim().substring(0, 50),
                  href: (el.href || '').substring(0, 80),
                  className: el.className || ''
                }));
              });

              if (todosLinks.length > 0) {
                this.log(`Frame ${frameUrl.substring(0, 50)}: ${todosLinks.length} links encontrados`);
              }

              // Procurar link direto para "Licitação e Dispensa (novo)" ou cnetmobile
              const linkDireto = await frame.evaluate(() => {
                const links = Array.from(document.querySelectorAll('a'));
                for (const el of links) {
                  const texto = (el.textContent || el.innerText || '').trim();
                  const textoLower = texto.toLowerCase();
                  const href = el.href || '';

                  // Procurar "Licitação e Dispensa (novo)" diretamente
                  if ((textoLower.includes('licitação') || textoLower.includes('licita')) &&
                      textoLower.includes('novo')) {
                    return { found: true, text: texto, href: href, type: 'submenu' };
                  }

                  // Procurar link para cnetmobile
                  if (href.includes('cnetmobile') || href.includes('comprasnet-web/seguro')) {
                    return { found: true, text: texto, href: href, type: 'cnetmobile' };
                  }
                }
                return { found: false };
              });

              if (linkDireto.found) {
                this.log(`Link direto encontrado: "${linkDireto.text}" (${linkDireto.type}) -> ${linkDireto.href}`);

                // Clicar no link usando evaluate
                await frame.evaluate((texto) => {
                  const links = Array.from(document.querySelectorAll('a'));
                  for (const el of links) {
                    const t = (el.textContent || el.innerText || '').trim();
                    if (t === texto || t.includes(texto.substring(0, 20))) {
                      el.click();
                      return true;
                    }
                  }
                  return false;
                }, linkDireto.text);

                await new Promise(r => setTimeout(r, 5000));
                navegouParaCnetmobile = true;
                menuEncontrado = true;
                break;
              }

              // Se não encontrou link direto, tentar hover no menu "Compras"
              // Usando JavaScript para disparar eventos de mouse diretamente
              const menuResult = await frame.evaluate(() => {
                const elementos = Array.from(document.querySelectorAll('a, span, div, li, td'));
                for (const el of elementos) {
                  const texto = (el.textContent || el.innerText || '').trim();
                  if (texto.toLowerCase() === 'compras' || texto === 'Compras') {
                    // Logar informações do elemento
                    const info = {
                      tag: el.tagName,
                      text: texto,
                      hasOnmouseover: !!el.onmouseover,
                      hasOnclick: !!el.onclick,
                      className: el.className,
                      id: el.id,
                      parentTag: el.parentElement ? el.parentElement.tagName : 'none'
                    };

                    // Disparar eventos de mouse
                    const mouseEnter = new MouseEvent('mouseenter', { bubbles: true, cancelable: true });
                    const mouseOver = new MouseEvent('mouseover', { bubbles: true, cancelable: true });
                    el.dispatchEvent(mouseEnter);
                    el.dispatchEvent(mouseOver);

                    // Também tentar trigger de onmouseover se existir
                    if (el.onmouseover) {
                      el.onmouseover();
                    }

                    return { found: true, info };
                  }
                }
                return { found: false };
              });

              if (menuResult.found) {
                this.log(`Menu "Compras" encontrado: ${JSON.stringify(menuResult.info)}`);
                this.log('Eventos de mouse disparados, aguardando submenu...');
                await new Promise(r => setTimeout(r, 2500)); // Aguardar submenu abrir

                menuEncontrado = true;

                // Verificar se há submenus visíveis agora
                const submenu = await frame.evaluate(() => {
                  // Procurar elementos que possam ser submenus (geralmente ul, div com display diferente de none)
                  const todosElementos = Array.from(document.querySelectorAll('a, li, span, div'));
                  const resultados = [];
                  for (const el of todosElementos) {
                    const texto = (el.textContent || el.innerText || '').trim();
                    const textoLower = texto.toLowerCase();

                    // Procurar "Licitação e Dispensa (novo)" ou variações
                    if ((textoLower.includes('licitação') || textoLower.includes('licita')) &&
                        textoLower.includes('novo')) {
                      const style = window.getComputedStyle(el);
                      resultados.push({
                        text: texto,
                        href: el.href || '',
                        visible: style.display !== 'none' && style.visibility !== 'hidden',
                        tag: el.tagName
                      });
                    }
                    // Também procurar "Dispensa" apenas
                    if (textoLower.includes('dispensa') && el.href) {
                      resultados.push({
                        text: texto,
                        href: el.href || '',
                        visible: true,
                        tag: el.tagName
                      });
                    }
                  }
                  return resultados;
                });

                this.log(`Itens encontrados após hover: ${JSON.stringify(submenu)}`);

                // Procurar pelo item correto
                const itemLicitacao = submenu.find(s =>
                  s.text.toLowerCase().includes('novo') &&
                  (s.text.toLowerCase().includes('licitação') || s.text.toLowerCase().includes('licita'))
                );

                if (itemLicitacao) {
                  this.log(`Submenu encontrado: ${itemLicitacao.text} -> ${itemLicitacao.href}`);

                  // Se tiver href, navegar diretamente
                  if (itemLicitacao.href && itemLicitacao.href.startsWith('http')) {
                    await this.page.goto(itemLicitacao.href, { waitUntil: 'networkidle2', timeout: 30000 });
                    navegouParaCnetmobile = true;
                  } else {
                    // Clicar no elemento
                    await frame.evaluate((texto) => {
                      const links = Array.from(document.querySelectorAll('a'));
                      for (const el of links) {
                        const t = (el.textContent || el.innerText || '').trim();
                        if (t.toLowerCase().includes('licitação') && t.toLowerCase().includes('novo')) {
                          el.click();
                          return true;
                        }
                      }
                      return false;
                    }, itemLicitacao.text);
                    await new Promise(r => setTimeout(r, 5000));
                    navegouParaCnetmobile = true;
                  }
                } else {
                  this.log('Submenu "Licitação e Dispensa (novo)" não encontrado');

                  // Tentar clicar no próprio menu "Compras" para ver se abre algo
                  const clicouCompras = await frame.evaluate(() => {
                    const elementos = Array.from(document.querySelectorAll('a, span, div'));
                    for (const el of elementos) {
                      const texto = (el.textContent || el.innerText || '').trim();
                      if (texto.toLowerCase() === 'compras') {
                        el.click();
                        return true;
                      }
                    }
                    return false;
                  });
                  if (clicouCompras) {
                    this.log('Clicou no menu "Compras"');
                    await new Promise(r => setTimeout(r, 3000));
                  }
                }
              }

              if (navegouParaCnetmobile) break;
            } catch (frameErr) {
              // Frame pode estar inacessível
              this.log(`Erro ao processar frame: ${frameErr.message}`);
            }
          }

          // Se não conseguiu navegar via menu nos frames, tentar clicar na aba "Compras" na página principal
          // O fluxo correto (conforme evidências): após login, área do fornecedor tem abas no topo
          // Clicar na aba "Compras" leva ao cnetmobile
          if (!navegouParaCnetmobile) {
            this.log('Tentando clicar na aba "Compras" na página principal...');

            try {
              // Na área do fornecedor (tela verde), procurar aba "Compras" e CLICAR (não hover)
              const clicouAbaCompras = await this.page.evaluate(() => {
                // Procurar em toda a página por link/aba "Compras"
                const elementos = Array.from(document.querySelectorAll('a, li, span, div, button'));
                for (const el of elementos) {
                  const texto = (el.textContent || el.innerText || '').trim();
                  // Procurar aba "Compras" exata ou link que contenha "Compras"
                  if (texto === 'Compras' || texto.toLowerCase() === 'compras') {
                    el.click();
                    return { clicked: true, text: texto, tag: el.tagName };
                  }
                }
                // Também tentar por href que contenha cnetmobile
                const links = Array.from(document.querySelectorAll('a'));
                for (const el of links) {
                  const href = el.href || '';
                  if (href.includes('cnetmobile') || href.includes('comprasnet-web/seguro')) {
                    el.click();
                    return { clicked: true, href: href, tag: 'A' };
                  }
                }
                return { clicked: false };
              });

              if (clicouAbaCompras.clicked) {
                this.log(`Clicou na aba/link: ${JSON.stringify(clicouAbaCompras)}`);
                await new Promise(r => setTimeout(r, 5000));
                navegouParaCnetmobile = true;
              } else {
                this.log('Aba "Compras" não encontrada na página principal');
              }
            } catch (e) {
              this.log(`Erro ao clicar na aba Compras: ${e.message}`);
            }
          }

          if (!menuEncontrado && !navegouParaCnetmobile) {
            this.log('Menu "Compras" não encontrado, listando todos os links na página...');

            // Listar todos os links disponíveis para debug
            const todosLinks = await this.page.evaluate(() => {
              const links = Array.from(document.querySelectorAll('a'));
              return links.slice(0, 30).map(el => ({
                text: (el.textContent || '').trim().substring(0, 40),
                href: (el.href || '').substring(0, 80)
              }));
            });
            this.log(`Links disponíveis: ${JSON.stringify(todosLinks, null, 2)}`);

            // Tentar clicar em qualquer link para cnetmobile
            const clicouDireto = await this.page.evaluate(() => {
              const links = Array.from(document.querySelectorAll('a'));
              for (const el of links) {
                const href = el.href || '';
                if (href.includes('cnetmobile') || href.includes('comprasnet-web/seguro')) {
                  el.click();
                  return { clicked: true, href: href };
                }
              }
              return { clicked: false };
            });

            if (clicouDireto.clicked) {
              this.log(`Clicou em link direto: ${clicouDireto.href}`);
              await new Promise(r => setTimeout(r, 5000));
            }
          }

          await new Promise(r => setTimeout(r, 3000));
          const urlFinal = this.page.url();
          this.log(`URL após navegação: ${urlFinal}`);

          if (urlFinal.includes('cnetmobile') && !urlFinal.includes('acesso-nao-autorizado')) {
            this.log('✅ Navegou para cnetmobile com sucesso!');
          } else if (urlFinal.includes('acesso-nao-autorizado')) {
            this.log('⚠️ Sessão não transferida - acesso não autorizado');
          } else {
            // Se ainda não chegou no cnetmobile, verificar se há link na página atual
            this.log('Verificando links disponíveis na página atual...');
            const linksDisponiveis = await this.page.evaluate(() => {
              const links = Array.from(document.querySelectorAll('a'));
              return links.slice(0, 20).map(el => ({
                text: (el.textContent || '').trim().substring(0, 50),
                href: (el.href || '').substring(0, 80)
              }));
            });
            this.log('Primeiros 20 links: ' + JSON.stringify(linksDisponiveis, null, 2));
          }
        } catch (e) {
          this.log('Erro ao navegar para área de licitações: ' + e.message);
        }
      }

      return;
    }

    this.log('Acessando Comprasnet para iniciar fluxo de autenticação...');

    // Acessar página principal do Comprasnet (área segura) para iniciar o fluxo de SSO
    try {
      await this.page.goto('https://cnetmobile.estaleiro.serpro.gov.br/comprasnet-web/public/compras', { waitUntil: 'networkidle2', timeout: 60000 });
    } catch (e) {
      this.log('Aguardando carregamento inicial...');
    }
    await new Promise(r => setTimeout(r, 3000));

    // Verificar se foi redirecionado para login ou se já está logado
    let urlAtual = this.page.url();
    this.log(`URL após acessar Comprasnet: ${urlAtual}`);

    // Procurar botão de login no Comprasnet
    let precisaLogin = false;
    try {
      const btnEntrar = await this.page.$('a[href*="login"], button:has-text("Entrar"), button:has-text("Login"), a:has-text("Entrar"), a:has-text("gov.br")');
      if (btnEntrar) {
        precisaLogin = true;
        await btnEntrar.click();
        this.log('Clicou no botão de login do Comprasnet');
        await new Promise(r => setTimeout(r, 5000));
      }
    } catch (e) {
      // Tentar clicar em qualquer link de login
      try {
        const links = await this.page.$$('a');
        for (const link of links) {
          const texto = await link.evaluate(el => el.innerText?.toLowerCase() || '');
          const href = await link.evaluate(el => el.href?.toLowerCase() || '');
          if (texto.includes('entrar') || texto.includes('login') || texto.includes('gov.br') || href.includes('login')) {
            await link.click();
            this.log('Clicou no link de login');
            precisaLogin = true;
            await new Promise(r => setTimeout(r, 5000));
            break;
          }
        }
      } catch (e2) {}
    }

    // Verificar se foi redirecionado para gov.br
    urlAtual = this.page.url();
    if (!urlAtual.includes('acesso.gov.br') && !urlAtual.includes('sso')) {
      // Tentar acessar área segura para forçar redirect
      this.log('Acessando área segura para iniciar SSO...');
      await this.page.goto('https://cnetmobile.estaleiro.serpro.gov.br/comprasnet-web/seguro/', { waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {});
      await new Promise(r => setTimeout(r, 5000));
      urlAtual = this.page.url();
    }

    this.log(`URL atual: ${urlAtual}`);

    // Verificar se estamos na página de login do gov.br
    if (!urlAtual.includes('acesso.gov.br') && !urlAtual.includes('sso')) {
      // Se não redirecionou, tentar ir direto mas com client_id do Comprasnet
      this.log('Acessando SSO gov.br via Comprasnet...');
      await this.page.goto('https://sso.acesso.gov.br/login?client_id=portal-logado.estaleiro.serpro.gov.br', { waitUntil: 'domcontentloaded', timeout: 120000 });
      await new Promise(r => setTimeout(r, 3000));
    }

    try {
      await this.page.waitForFunction(() => document.body.innerText.length > 100, { timeout: 60000 });
    } catch (e) {
      this.log('Aguardando carregamento da página...');
    }

    // Se usar certificado, clicar na opção de certificado digital
    if (this.usarCertificado) {
      this.log('Procurando opção de login com certificado digital...');
      await new Promise(r => setTimeout(r, 2000));

      // Procurar link/botão de certificado digital
      let certLink = null;
      try {
        const links = await this.page.$$('a, button, div[role="button"]');
        for (const link of links) {
          const texto = await link.evaluate(el => el.innerText.toLowerCase());
          if (texto.includes('certificado') || texto.includes('digital')) {
            certLink = link;
            this.log('Link de certificado encontrado');
            break;
          }
        }
      } catch (e) {}

      if (certLink) {
        await certLink.click();
        this.log('Clicou no login com certificado digital');

        // Aguardar popup de seleção de certificado (pode levar até 30s)
        this.log('Aguardando seleção de certificado pelo Windows...');
        await new Promise(r => setTimeout(r, 10000));

        // Verificar se foi redirecionado para página de certificado
        const urlAposCert = this.page.url();
        this.log(`URL após certificado: ${urlAposCert}`);

        // Aguardar redirecionamento após seleção do certificado
        try {
          await this.page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 90000 });
        } catch (e) {
          this.log('Timeout aguardando navegação após certificado');
        }
        await new Promise(r => setTimeout(r, 5000));

        // Verificar se login foi bem sucedido (deve redirecionar de volta ao Comprasnet)
        const urlFinal = this.page.url();
        this.log(`URL final: ${urlFinal}`);

        if (urlFinal.includes('comprasnet') || urlFinal.includes('cnetmobile')) {
          this.log('Login com certificado realizado com sucesso!');
          return;
        }

        if (!urlFinal.includes('login') && !urlFinal.includes('acesso.gov.br/login')) {
          this.log('Redirecionado - verificando login...');
          await new Promise(r => setTimeout(r, 3000));
          const urlVerificacao = this.page.url();
          if (urlVerificacao.includes('comprasnet') || urlVerificacao.includes('cnetmobile')) {
            this.log('Login com certificado realizado com sucesso!');
            return;
          }
        }

        this.log('Login com certificado pode ter falhado, tentando CPF/senha...');
      } else {
        this.log('Link de certificado não encontrado, usando CPF/senha...');
      }
    }

    // Login com CPF/senha (fallback ou método principal)
    if (!this.cpf || !this.senhaGovbr) {
      throw new Error('Credenciais CPF/senha não disponíveis');
    }

    this.log('Fazendo login com CPF/senha...');

    // Verificar se estamos na página de login, senão navegar para ela mantendo o client_id
    urlAtual = this.page.url();
    if (!urlAtual.includes('acesso.gov.br')) {
      await this.page.goto('https://sso.acesso.gov.br/login?client_id=portal-logado.estaleiro.serpro.gov.br', { waitUntil: 'networkidle2', timeout: 120000 });
      await new Promise(r => setTimeout(r, 5000));
    }

    // Preencher CPF
    this.log('Preenchendo CPF...');
    let cpfInput = null;
    for (let i = 0; i < 10; i++) {
      cpfInput = await this.page.$('input[name="accountId"]') || await this.page.$('input[type="text"]');
      if (cpfInput) break;
      await new Promise(r => setTimeout(r, 1000));
    }
    if (!cpfInput) throw new Error('Campo CPF não encontrado');

    await cpfInput.click();
    await cpfInput.type(this.cpf.replace(/\D/g, ''), { delay: 50 });

    // Clicar em continuar
    await new Promise(r => setTimeout(r, 500));
    const btnContinuar = await this.page.$('button[type="submit"]');
    if (btnContinuar) await btnContinuar.click();
    else await this.page.keyboard.press('Enter');

    // Aguardar navegação após clicar em continuar
    this.log('Aguardando transição para tela de senha...');
    try {
      await this.page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 });
    } catch (e) {
      // Pode ser SPA sem navegação real
    }
    await new Promise(r => setTimeout(r, 5000));

    // Preencher senha
    this.log('Preenchendo senha...');
    let senhaInput = null;
    for (let i = 0; i < 30; i++) {
      senhaInput = await this.page.$('input[name="password"]') || await this.page.$('input[type="password"]');
      if (senhaInput) break;
      await new Promise(r => setTimeout(r, 1000));
    }

    if (!senhaInput) {
      const pageText = await this.page.evaluate(() => document.body.innerText);
      if (pageText.includes('código') || pageText.includes('verificação')) {
        throw new Error('Login requer verificação por código. Faça login manualmente primeiro.');
      }
      throw new Error('Campo de senha não encontrado');
    }

    await senhaInput.click();
    await senhaInput.type(this.senhaGovbr, { delay: 50 });

    // Clicar em entrar
    await new Promise(r => setTimeout(r, 500));
    const btnLogin = await this.page.$('button[type="submit"]');
    if (btnLogin) await btnLogin.click();
    else await this.page.keyboard.press('Enter');

    this.log('Aguardando login...');
    await this.page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 3000));

    // Verificar se login foi bem sucedido
    let url = this.page.url();
    if (url.includes('login') || url.includes('acesso.gov.br/login')) {
      const content = await this.page.content();
      if (content.includes('incorret') || content.includes('inválid')) {
        throw new Error('CPF ou senha incorretos');
      }
    }

    this.log(`URL após login: ${url}`);

    // Verificar se foi redirecionado para página de recuperação (redirecionamento incorreto)
    if (url.includes('recupera') || url.includes('validacao-facial')) {
      this.log('⚠️ Redirecionamento incorreto para página de recuperação detectado!');
      this.log('Tentando contornar voltando para área do Comprasnet...');

      // Limpar cookies do gov.br e tentar novamente
      try {
        // Navegar diretamente para o Comprasnet ignorando o redirect incorreto
        await this.page.goto('https://cnetmobile.estaleiro.serpro.gov.br/comprasnet-web/seguro/fornecedor/', { waitUntil: 'networkidle2', timeout: 60000 });
        await new Promise(r => setTimeout(r, 5000));

        url = this.page.url();
        this.log(`URL após contorno: ${url}`);

        // Se ainda está no login ou recuperação, tentar fluxo alternativo
        if (url.includes('acesso.gov.br') || url.includes('recupera')) {
          this.log('Tentando fluxo de login alternativo via portal Compras.gov.br...');

          // Ir para página pública e clicar em entrar
          await this.page.goto('https://www.gov.br/compras/pt-br', { waitUntil: 'networkidle2', timeout: 60000 });
          await new Promise(r => setTimeout(r, 3000));

          // Procurar link de login
          const loginLinks = await this.page.$$('a');
          for (const link of loginLinks) {
            const href = await link.evaluate(el => el.href || '');
            const texto = await link.evaluate(el => el.innerText?.toLowerCase() || '');
            if (texto.includes('entrar') || texto.includes('acesse') || href.includes('login')) {
              await link.click();
              this.log('Clicou em entrar no portal Compras.gov.br');
              await new Promise(r => setTimeout(r, 5000));
              break;
            }
          }

          url = this.page.url();
          this.log(`URL após fluxo alternativo: ${url}`);
        }
      } catch (e) {
        this.log('Erro no contorno: ' + e.message);
      }
    }

    // Verificar se foi redirecionado de volta ao Comprasnet
    if (!url.includes('comprasnet') && !url.includes('cnetmobile')) {
      // Tentar navegar para área segura do Comprasnet
      this.log('Navegando para área segura do Comprasnet...');
      await this.page.goto('https://cnetmobile.estaleiro.serpro.gov.br/comprasnet-web/seguro/fornecedor/', { waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {});
      await new Promise(r => setTimeout(r, 5000));

      url = this.page.url();
      this.log(`URL após redirecionamento: ${url}`);

      // Verificar se ainda precisa autenticar
      if (url.includes('acesso.gov.br') || url.includes('sso')) {
        this.log('Ainda na página de login - sessão pode não ter sido estabelecida corretamente');
        // Tentar aguardar mais um pouco por navegação
        await this.page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
        url = this.page.url();
      }
    }

    // Verificar se chegou ao Comprasnet com sucesso
    if (url.includes('acesso-nao-autorizado')) {
      throw new Error('Acesso não autorizado. Verifique suas credenciais e permissões.');
    }

    this.log('Login realizado com sucesso!');
  }

  async carregarParticipacoes() {
    // Buscar licitações AUTOMATICAMENTE da página de participações do cnetmobile
    this.log('Buscando participações automaticamente do Comprasnet...');

    // Buscar CNPJ do fornecedor
    const cnpjFornecedor = getConfigValue('cnpj');
    this.cnpjFornecedor = cnpjFornecedor ? cnpjFornecedor.replace(/\D/g, '') : null;

    if (this.cnpjFornecedor) {
      this.log(`CNPJ do fornecedor: ${this.cnpjFornecedor}`);
    }

    // Navegar para a página de participações
    const urlParticipacoes = 'https://cnetmobile.estaleiro.serpro.gov.br/comprasnet-web/seguro/fornecedor/compras';

    try {
      // SEMPRE navegar para a página de participações para garantir
      const urlAtual = this.page.url();
      this.log(`URL atual: ${urlAtual}`);

      this.log('Navegando para página de participações...');
      await this.page.goto(urlParticipacoes, { waitUntil: 'networkidle2', timeout: 60000 });
      await new Promise(r => setTimeout(r, 3000));

      // Garantir que estamos na aba "Minhas participações"
      await this.page.evaluate(() => {
        const abas = document.querySelectorAll('.p-tabview-nav-link');
        for (const aba of abas) {
          if (aba.textContent?.includes('Minhas participações')) {
            aba.click();
            break;
          }
        }
      });
      await new Promise(r => setTimeout(r, 2000));

      // Extrair todas as licitações da página (baseado nos botões de acompanhar)
      const participacoes = await this.page.evaluate(() => {
        const licitacoes = [];
        const jaAdicionadas = new Set();

        // Encontrar todos os botões de acompanhar (visíveis)
        const botoes = Array.from(document.querySelectorAll('[aria-label*="Participar"], [aria-label*="acompanhar"]'))
          .filter(b => b.offsetParent !== null);

        botoes.forEach((btn, index) => {
          // Subir na árvore DOM para encontrar o card pai
          let card = btn.closest('[class*="card"]') || btn.closest('[class*="ng-star-inserted"]') || btn.parentElement?.parentElement?.parentElement;
          if (!card) return;

          const texto = card.innerText || '';

          // Verificar se parece ser um card de licitação (tem número de dispensa/pregão)
          const matchNumero = texto.match(/(PREGÃO|DISPENSA|CONCORRÊNCIA|COTAÇÃO)[^0-9]*N[°º]?\s*(\d+)\/(\d{4})/i);
          const matchOrgao = texto.match(/(\d{6})\s*-\s*([A-Z\s]+)/);
          const matchEtapa = texto.match(/Etapa:\s*([^\n]+)/i);

          if (matchNumero) {
            // Criar chave única para evitar duplicatas
            const chave = `${matchNumero[1]}_${matchNumero[2]}_${matchNumero[3]}_${matchOrgao ? matchOrgao[1] : ''}`;

            if (!jaAdicionadas.has(chave)) {
              jaAdicionadas.add(chave);
              licitacoes.push({
                tipo: matchNumero[1],
                numero: matchNumero[2],
                ano: matchNumero[3],
                orgao: matchOrgao ? matchOrgao[2].trim() : '',
                uasg: matchOrgao ? matchOrgao[1] : '',
                etapa: matchEtapa ? matchEtapa[1].trim() : '',
                indiceBotao: index // Índice do botão para clicar
              });
            }
          }
        });

        return licitacoes;
      });

      this.log(`Encontradas ${participacoes.length} licitações nas participações`);

      // Salvar as participações
      this.participacoes = participacoes;

      // Log das licitações encontradas
      participacoes.forEach((p, i) => {
        this.log(`  ${i + 1}. ${p.tipo} ${p.numero}/${p.ano} - ${p.orgao} (${p.etapa})`);
      });

      return participacoes;

    } catch (error) {
      this.log(`Erro ao carregar participações: ${error.message}`);
      this.participacoes = [];
      return [];
    }
  }

  async irParaMensagens() {
    // Carregar participações automaticamente da página
    await this.carregarParticipacoes();

    if (this.participacoes.length === 0) {
      this.log('Nenhuma licitação encontrada nas participações');
      this.log('Verifique se você está logado e tem participações ativas');
    } else {
      this.log(`Pronto para monitorar ${this.participacoes.length} licitações`);
    }

    this.log('Navegação inicial concluída');
  }

  async acessarLicitacaoPorIndice(indice) {
    // SEMPRE navegar para a página de participações primeiro
    this.log(`Voltando para lista de participações...`);
    await this.page.goto('https://cnetmobile.estaleiro.serpro.gov.br/comprasnet-web/seguro/fornecedor/compras', { waitUntil: 'networkidle2', timeout: 60000 });
    await new Promise(r => setTimeout(r, 2000));

    // Garantir que estamos na aba "Minhas participações"
    await this.page.evaluate(() => {
      const abas = document.querySelectorAll('.p-tabview-nav-link');
      for (const aba of abas) {
        if (aba.textContent?.includes('Minhas participações')) {
          aba.click();
          break;
        }
      }
    });
    await new Promise(r => setTimeout(r, 1000));

    // Clicar no botão de acompanhar da licitação no índice especificado
    const clicou = await this.page.evaluate((idx) => {
      // Encontrar todos os botões de acompanhar (visíveis)
      const botoes = Array.from(document.querySelectorAll('[aria-label*="Participar"], [aria-label*="acompanhar"]'))
        .filter(b => b.offsetParent !== null); // Só visíveis

      if (botoes[idx]) {
        botoes[idx].click();
        return { success: true, total: botoes.length };
      }
      return { success: false, total: botoes.length };
    }, indice);

    if (clicou.success) {
      await new Promise(r => setTimeout(r, 3000));
      this.log(`Acessou licitação ${indice + 1} de ${clicou.total}`);
      return true;
    } else {
      this.log(`Não foi possível clicar na licitação ${indice + 1} (${clicou.total} disponíveis)`);
      return false;
    }
  }

  construirUrlAcompanhamento(participacao) {
    // Se já tem URL cadastrada, usar diretamente
    if (participacao.urlCompra) {
      return participacao.urlCompra;
    }

    // URL do acompanhamento: https://cnetmobile.estaleiro.serpro.gov.br/comprasnet-web/seguro/fornecedor/acompanhamento-compra?compra=CNPJ+SEQUENCIAL+ANO
    const cnpj = participacao.cnpjOrgao.replace(/\D/g, '');
    const sequencial = participacao.sequencial.toString().padStart(5, '0');
    const ano = participacao.ano.toString();
    const compraId = `${cnpj}${sequencial}${ano}`;
    return `https://cnetmobile.estaleiro.serpro.gov.br/comprasnet-web/seguro/fornecedor/acompanhamento-compra?compra=${compraId}`;
  }

  // Classifica a prioridade da licitação baseada na etapa
  getPrioridade(etapa) {
    if (!etapa) return 2; // Média se não tem etapa
    const etapaLower = etapa.toLowerCase();

    // ALTA PRIORIDADE (verificar sempre) - etapas críticas de julgamento
    const altaPrioridade = [
      'seleção de fornecedores', 'selecao de fornecedores', 'seleção', 'selecao',
      'disputa', 'lance', 'lances',
      'análise', 'analise', 'julgamento',
      'negociação', 'negociacao',
      'habilitação', 'habilitacao',
      'envio de proposta', 'proposta',
      'em andamento', 'aberta'
    ];

    // BAIXA PRIORIDADE (verificar menos) - etapas finalizadas ou iniciais
    const baixaPrioridade = [
      'encerrada', 'encerrado', 'finalizada', 'finalizado',
      'homologada', 'homologado', 'adjudicada', 'adjudicado',
      'cancelada', 'cancelado', 'suspensa', 'suspenso',
      'deserta', 'fracassada', 'revogada', 'anulada',
      'publicada', 'agendada'
    ];

    for (const termo of altaPrioridade) {
      if (etapaLower.includes(termo)) return 1; // Alta
    }

    for (const termo of baixaPrioridade) {
      if (etapaLower.includes(termo)) return 3; // Baixa
    }

    return 2; // Média
  }

  iniciarVerificacao() {
    // Controle de priorização
    this.indiceAtual = 0;
    this.cicloAtual = 0;
    this.ultimasVerificacoes = new Map(); // Rastreia última verificação de cada licitação

    // Verificar mensagens a cada 20 segundos (reduzido de 30)
    this.intervalo = setInterval(async () => {
      if (!this.ativo) return;

      try {
        await this.verificarMensagensLicitacao();
      } catch (error) {
        this.log('Erro na verificação: ' + error.message);
      }
    }, 20000);

    // Fazer primeira verificação imediatamente
    this.verificarMensagensLicitacao();
  }

  // Seleciona a próxima licitação baseada em prioridade
  selecionarProximaLicitacao() {
    if (!this.participacoes || this.participacoes.length === 0) return null;

    const agora = Date.now();

    // Configuração de intervalos mínimos por prioridade (em ms)
    const intervalos = {
      1: 20000,   // Alta: verificar a cada ciclo (~20s)
      2: 60000,   // Média: verificar a cada 3 ciclos (~1min)
      3: 180000   // Baixa: verificar a cada 9 ciclos (~3min)
    };

    // Ordenar por prioridade e tempo desde última verificação
    const candidatas = this.participacoes.map((p, idx) => {
      const prioridade = this.getPrioridade(p.etapa);
      const ultimaVerif = this.ultimasVerificacoes.get(idx) || 0;
      const tempoDesde = agora - ultimaVerif;
      const intervaloMinimo = intervalos[prioridade];
      const prontoParaVerificar = tempoDesde >= intervaloMinimo;

      return {
        participacao: p,
        indice: idx,
        prioridade,
        tempoDesde,
        prontoParaVerificar,
        // Score: prioridade baixa = melhor, tempo desde último = melhor
        score: prontoParaVerificar ? (prioridade * 1000 - tempoDesde) : Infinity
      };
    });

    // Filtrar apenas as prontas para verificar e ordenar por score
    const prontas = candidatas
      .filter(c => c.prontoParaVerificar)
      .sort((a, b) => a.score - b.score);

    if (prontas.length > 0) {
      const escolhida = prontas[0];
      this.log(`[Prioridade ${escolhida.prioridade}] ${escolhida.participacao.tipo} ${escolhida.participacao.numero}/${escolhida.participacao.ano} - ${escolhida.participacao.etapa || 'sem etapa'}`);
      return escolhida;
    }

    // Se nenhuma está pronta, pegar a de maior prioridade
    candidatas.sort((a, b) => a.prioridade - b.prioridade || b.tempoDesde - a.tempoDesde);
    return candidatas[0];
  }

  async verificarMensagensLicitacao() {
    try {
      this.ultimaVerificacao = new Date();
      this.cicloAtual++;

      // Recarregar participações a cada 20 ciclos (~6-7 minutos)
      if (!this.participacoes || this.participacoes.length === 0 || this.cicloAtual % 20 === 1) {
        await this.carregarParticipacoes();
        if (this.participacoes.length === 0) {
          this.log('Nenhuma participação encontrada - aguardando próximo ciclo');
          return;
        }
      }

      // Selecionar licitação baseada em prioridade
      const selecionada = this.selecionarProximaLicitacao();
      if (!selecionada) {
        this.log('Nenhuma licitação para verificar neste ciclo');
        return;
      }

      // Atualizar última verificação
      this.ultimasVerificacoes.set(selecionada.indice, Date.now());
      this.indiceAtual = selecionada.indice;

      // Pegar licitação atual
      const participacao = selecionada.participacao;

      this.log(`Verificando licitação ${this.indiceAtual + 1}/${this.participacoes.length}: ${participacao.tipo} ${participacao.numero}/${participacao.ano} - ${participacao.orgao}`);

      // Acessar a licitação clicando no botão (usando indiceBotao se disponível)
      const indiceBotao = participacao.indiceBotao !== undefined ? participacao.indiceBotao : this.indiceAtual;
      const acessou = await this.acessarLicitacaoPorIndice(indiceBotao);

      if (!acessou) {
        this.log('Não foi possível acessar a licitação - tentando próxima');
        this.indiceAtual = (this.indiceAtual + 1) % this.participacoes.length;
        return;
      }

      // Verificar se sessão expirou
      const urlAtual = this.page.url();
      if (urlAtual.includes('acesso-nao-autorizado') || urlAtual.includes('login')) {
        this.log('Sessão expirada - tentando re-autenticar...');

        // Tentar refazer login
        try {
          await this.fazerLogin();
          // Voltar para a licitação
          await this.acessarLicitacaoPorIndice(this.indiceAtual);

          const urlAposRelogin = this.page.url();
          if (urlAposRelogin.includes('acesso-nao-autorizado')) {
            this.log('Falha ao re-autenticar - parando monitoramento');
            await this.parar();
            await enviarTelegram('🔴 <b>Monitor Parado</b>\n\nSessão expirou e não foi possível re-autenticar. Reinicie o monitor manualmente.');
            return;
          }
        } catch (e) {
          this.log('Erro ao re-autenticar: ' + e.message);
          return;
        }
      }

      // Buscar mensagens do chat na página
      await this.extrairMensagensChat(participacao);

      // Avançar para próxima licitação (circular)
      this.indiceAtual = (this.indiceAtual + 1) % this.participacoes.length;

    } catch (error) {
      this.log('Erro ao verificar licitação: ' + error.message);
      // Avançar mesmo com erro
      this.indiceAtual = (this.indiceAtual + 1) % Math.max(1, this.participacoes.length);
    }
  }

  // Gera chave única para a licitação
  getChaveLicitacao(participacao) {
    return `${participacao.uasg || ''}_${participacao.tipo || ''}_${participacao.numero || ''}_${participacao.ano || ''}`;
  }

  // Verifica se há mensagens mais recentes no portal
  async verificarMensagemMaisRecente(participacao) {
    try {
      // Buscar última verificação do banco
      const chave = this.getChaveLicitacao(participacao);
      const ultimaVerif = db.prepare('SELECT ultimaDataHoraMensagem, totalMensagens FROM chat_ultima_verificacao WHERE chave = ?').get(chave);

      // Capturar rapidamente a última mensagem visível na página
      const infoMensagens = await this.page.evaluate(() => {
        const mensagens = document.querySelectorAll('[class*="message"], [class*="chat-item"], [class*="msg-"], .p-card, [class*="comunicado"]');
        if (mensagens.length === 0) return { total: 0, ultimaData: null };

        const ultimaMensagem = mensagens[mensagens.length - 1] || mensagens[0];
        const textoData = ultimaMensagem.innerText || '';
        const matchData = textoData.match(/(\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}|\d{2}:\d{2}\s+\d{2}\/\d{2}\/\d{4})/);

        return {
          total: mensagens.length,
          ultimaData: matchData ? matchData[1] : null,
          textoPreview: textoData.substring(0, 100)
        };
      });

      // Se não tem registro anterior, precisa sincronizar
      if (!ultimaVerif) {
        this.log(`[NOVA] Licitação sem histórico - sincronizando...`);
        return { precisaSincronizar: true, motivo: 'sem_historico' };
      }

      // Comparar quantidade de mensagens
      if (infoMensagens.total > (ultimaVerif.totalMensagens || 0)) {
        this.log(`[ATUALIZAR] Novas mensagens detectadas: ${infoMensagens.total} vs ${ultimaVerif.totalMensagens} salvas`);
        return { precisaSincronizar: true, motivo: 'novas_mensagens', novas: infoMensagens.total - (ultimaVerif.totalMensagens || 0) };
      }

      // Comparar data/hora se disponível
      if (infoMensagens.ultimaData && ultimaVerif.ultimaDataHoraMensagem) {
        if (infoMensagens.ultimaData !== ultimaVerif.ultimaDataHoraMensagem) {
          this.log(`[ATUALIZAR] Data diferente: ${infoMensagens.ultimaData} vs ${ultimaVerif.ultimaDataHoraMensagem}`);
          return { precisaSincronizar: true, motivo: 'data_diferente' };
        }
      }

      // Sem mudanças detectadas
      this.log(`[SKIP] Sem novas mensagens - pulando extração completa`);
      return { precisaSincronizar: false, motivo: 'sem_mudancas' };

    } catch (error) {
      this.log(`Erro na verificação rápida: ${error.message} - sincronizando por segurança`);
      return { precisaSincronizar: true, motivo: 'erro' };
    }
  }

  // Atualiza registro de última verificação
  atualizarUltimaVerificacao(participacao, ultimaDataHora, totalMensagens, ultimoHash) {
    const chave = this.getChaveLicitacao(participacao);
    try {
      db.prepare(`
        INSERT INTO chat_ultima_verificacao (chave, ultimaDataHoraMensagem, ultimoHashMensagem, totalMensagens, dataVerificacao)
        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(chave) DO UPDATE SET
          ultimaDataHoraMensagem = excluded.ultimaDataHoraMensagem,
          ultimoHashMensagem = excluded.ultimoHashMensagem,
          totalMensagens = excluded.totalMensagens,
          dataVerificacao = CURRENT_TIMESTAMP
      `).run(chave, ultimaDataHora, ultimoHash, totalMensagens);
    } catch (e) {
      this.log(`Erro ao atualizar última verificação: ${e.message}`);
    }
  }

  async extrairMensagensChat(participacao) {
    try {
      const crypto = require('crypto');

      // OTIMIZAÇÃO: Verificar se há mensagens novas antes de extrair tudo
      const verificacao = await this.verificarMensagemMaisRecente(participacao);
      if (!verificacao.precisaSincronizar) {
        return; // Pula extração completa - sem mensagens novas
      }

      this.log(`Extraindo mensagens do chat (motivo: ${verificacao.motivo})...`);

      // Primeiro, clicar no ícone de envelope/chat para abrir o painel de mensagens
      try {
        this.log('Procurando ícone de chat/mensagens...');

        // Procurar e clicar no ícone de envelope/chat
        const chatAberto = await this.page.evaluate(() => {
          // Seletores para o ícone de chat/mensagens no Comprasnet
          const seletoresChat = [
            // Ícones Font Awesome
            '.fa-envelope',
            '.fa-comments',
            '.fa-comment',
            '.fa-comment-alt',
            '.fa-message',
            // Ícones Material
            '.material-icons:contains("chat")',
            '.material-icons:contains("mail")',
            // PrimeNG icons
            '.pi-envelope',
            '.pi-comments',
            // Botões com texto
            'button[title*="chat" i]',
            'button[title*="mensagem" i]',
            'button[title*="message" i]',
            'button[aria-label*="chat" i]',
            'button[aria-label*="mensagem" i]',
            // Links com ícones
            'a[title*="chat" i]',
            'a[title*="mensagem" i]',
            // Ícone com classe específica
            '[class*="chat-icon"]',
            '[class*="message-icon"]',
            '[class*="envelope"]',
            // Menu de ações
            '.p-menuitem-icon.fa-envelope',
            '.p-menuitem-icon.fa-comments',
            // Elementos com data-*
            '[data-action="chat"]',
            '[data-action="messages"]'
          ];

          for (const seletor of seletoresChat) {
            try {
              const elementos = document.querySelectorAll(seletor);
              for (const el of elementos) {
                if (el && el.offsetParent !== null) { // Visível
                  el.click();
                  return { clicked: true, seletor };
                }
              }
            } catch (e) {
              // Seletor inválido, tentar próximo
            }
          }

          // Tentar encontrar por texto do elemento pai
          const todosBotoes = document.querySelectorAll('button, a, span, i, div[role="button"]');
          for (const btn of todosBotoes) {
            const texto = (btn.innerText || btn.title || btn.getAttribute('aria-label') || '').toLowerCase();
            const classe = (btn.className || '').toLowerCase();

            if ((texto.includes('mensagem') || texto.includes('chat') || texto.includes('message') ||
                 classe.includes('envelope') || classe.includes('comment') || classe.includes('message')) &&
                btn.offsetParent !== null) {
              btn.click();
              return { clicked: true, seletor: 'texto/classe encontrado' };
            }
          }

          // Verificar se já existe painel de chat aberto
          const painelChat = document.querySelector('[class*="chat-panel"], [class*="message-panel"], .p-sidebar, .p-dialog');
          if (painelChat && painelChat.offsetParent !== null) {
            return { clicked: false, jaAberto: true };
          }

          return { clicked: false };
        });

        if (chatAberto.clicked) {
          this.log(`Clicou no ícone de chat (${chatAberto.seletor}), aguardando painel...`);
          await new Promise(r => setTimeout(r, 2000));
        } else if (chatAberto.jaAberto) {
          this.log('Painel de chat já está aberto');
        } else {
          this.log('Ícone de chat não encontrado - tentando extrair da página atual');
        }
      } catch (e) {
        this.log('Erro ao abrir chat: ' + e.message);
      }

      // DEBUG: Capturar estrutura da página para encontrar os seletores corretos
      const estruturaPagina = await this.page.evaluate(() => {
        const debugInfo = {
          url: window.location.href,
          classes: [],
          divs: [],
          tables: [],
          textosSample: [],
          botoesEIcones: [],
          sidebars: []
        };

        // Pegar todas as classes únicas na página
        const allClasses = new Set();
        document.querySelectorAll('*').forEach(el => {
          if (el.classList) {
            el.classList.forEach(c => allClasses.add(c));
          }
        });
        debugInfo.classes = [...allClasses].slice(0, 100);

        // Helper para obter className de forma segura (SVG tem className como objeto)
        const getClassName = (el) => {
          try {
            if (!el || !el.className) return '';
            if (typeof el.className === 'string') return el.className;
            if (el.className && el.className.baseVal !== undefined) return el.className.baseVal; // SVGAnimatedString
            if (el.classList && el.classList.length > 0) return Array.from(el.classList).join(' ');
            return String(el.className || '');
          } catch (e) {
            return '';
          }
        };

        // Pegar TODOS os botões e ícones
        document.querySelectorAll('button, a, i, span[class*="icon"], span[class*="fa-"], [role="button"]').forEach(el => {
          if (el.offsetParent !== null) { // Só visíveis
            debugInfo.botoesEIcones.push({
              tag: el.tagName,
              classe: getClassName(el).substring(0, 80),
              texto: (el.innerText || '').substring(0, 50),
              title: el.title || '',
              ariaLabel: el.getAttribute('aria-label') || ''
            });
          }
        });
        debugInfo.botoesEIcones = debugInfo.botoesEIcones.slice(0, 50);

        // Pegar sidebars e painéis
        document.querySelectorAll('.p-sidebar, .p-dialog, [class*="panel"], [class*="sidebar"], [class*="drawer"]').forEach(el => {
          debugInfo.sidebars.push({
            classe: getClassName(el).substring(0, 80),
            visivel: el.offsetParent !== null,
            textoResumido: (el.innerText || '').substring(0, 200)
          });
        });

        // Pegar divs com texto relevante (possivelmente mensagens)
        document.querySelectorAll('div, span, p, td').forEach(el => {
          const texto = el.innerText?.trim();
          if (texto && texto.length > 20 && texto.length < 500 && !el.querySelector('div')) {
            // Elemento com texto que não contém outros divs (elemento folha)
            debugInfo.textosSample.push({
              tag: el.tagName,
              classe: getClassName(el).substring(0, 50),
              texto: texto.substring(0, 100)
            });
          }
        });
        debugInfo.textosSample = debugInfo.textosSample.slice(0, 20);

        // Procurar elementos específicos de chat
        const chatElements = document.querySelectorAll('[class*="chat"], [class*="mensagem"], [class*="message"], [class*="timeline"], [class*="historico"]');
        debugInfo.chatElementsCount = chatElements.length;

        return debugInfo;
      });

      // Salvar debug em arquivo para análise
      const fs = require('fs');
      fs.writeFileSync('C:/Users/User/pncp-licitacoes/debug-pagina.json', JSON.stringify(estruturaPagina, null, 2));
      this.log(`DEBUG: Estrutura salva em debug-pagina.json (${estruturaPagina.textosSample.length} textos encontrados)`);

      // Extrair mensagens do chat do Comprasnet
      const mensagensExtraidas = await this.page.evaluate(() => {
        const mensagens = [];

        // Seletores específicos do Comprasnet (baseado na estrutura típica)
        const seletores = [
          // Chat do pregão
          '.chat-container .mensagem',
          '.chat-box .message',
          '.mensagens-chat .item',
          // Timeline de eventos
          '.timeline .event',
          '.historico .item',
          // Tabela de mensagens
          'table tbody tr',
          // Genéricos
          '[class*="mensagem"]',
          '[class*="message"]',
          '.card-body',
          // Div com texto de chat
          '.chat-content div',
          '.messages div'
        ];

        // Tentar cada seletor
        for (const seletor of seletores) {
          const elementos = document.querySelectorAll(seletor);
          if (elementos.length > 0) {
            elementos.forEach(el => {
              const texto = el.innerText?.trim();
              if (texto && texto.length > 10 && texto.length < 5000) {
                // Tentar extrair remetente e hora
                let remetente = '';
                let hora = '';

                // Procurar padrões comuns de remetente/hora
                const matchRemetente = texto.match(/^([A-Za-záàâãéèêíïóôõöúçñÁÀÂÃÉÈÊÍÏÓÔÕÖÚÇÑ\s]+?)[\s:-]/);
                const matchHora = texto.match(/(\d{2}[:/]\d{2}(?:[:/]\d{2})?)/);

                if (matchRemetente) remetente = matchRemetente[1].trim();
                if (matchHora) hora = matchHora[1];

                mensagens.push({
                  texto: texto,
                  remetente: remetente || 'Pregoeiro/Sistema',
                  hora: hora || new Date().toLocaleTimeString('pt-BR')
                });
              }
            });
            if (mensagens.length > 0) break;
          }
        }

        // Se não encontrou com seletores, tentar extrair do texto geral
        if (mensagens.length === 0) {
          const bodyText = document.body.innerText;
          // Dividir por linhas que parecem ser mensagens (contém hora ou padrão de chat)
          const linhas = bodyText.split('\n').filter(l => l.trim().length > 20);
          linhas.forEach(linha => {
            if (linha.match(/\d{2}:\d{2}/) || linha.toLowerCase().includes('pregoeiro')) {
              mensagens.push({
                texto: linha.trim(),
                remetente: 'Sistema',
                hora: new Date().toLocaleTimeString('pt-BR')
              });
            }
          });
        }

        return mensagens;
      });

      this.log(`Mensagens extraídas: ${mensagensExtraidas.length}`);

      if (mensagensExtraidas.length === 0) {
        this.log('Nenhuma mensagem encontrada com os seletores atuais');
      }

      // Buscar palavras-chave
      const palavrasChave = db.prepare('SELECT palavra FROM chat_palavras_chave WHERE ativo = 1').all();

      // Identificador da licitação para hash e log
      const licitacaoId = `${participacao.uasg || ''}_${participacao.tipo || ''}_${participacao.numero || ''}_${participacao.ano || ''}`;
      const licitacaoDisplay = `${participacao.tipo || ''} ${participacao.numero || ''}/${participacao.ano || ''} - ${participacao.orgao || ''}`;

      // Processar cada mensagem extraída
      for (const msg of mensagensExtraidas) {
        // FILTRAR mensagens de erro de Captcha e mensagens de sistema
        const textoLimpo = msg.texto.toLowerCase();
        if (textoLimpo.includes('captcha') ||
            textoLimpo.includes('não foi possível realizar a validação') ||
            textoLimpo.includes('não há mensagens para esta compra') ||
            textoLimpo.includes('tente mais tarde') ||
            msg.remetente === 'Informação' ||
            msg.remetente === 'Não') {
          continue; // Ignorar mensagens de erro/sistema
        }

        // Criar hash único da mensagem
        const hashMensagem = crypto
          .createHash('md5')
          .update(`${licitacaoId}_${msg.texto}`)
          .digest('hex');

        // Verificar se já existe no banco
        const jaExiste = db.prepare('SELECT id, notificado FROM chat_mensagens WHERE hashMensagem = ?').get(hashMensagem);

        if (jaExiste) {
          continue; // Mensagem já processada
        }

        // Verificar CNPJ do fornecedor
        const temCnpj = this.cnpjFornecedor && msg.texto.includes(this.cnpjFornecedor);

        // Verificar palavras-chave
        const textoLower = msg.texto.toLowerCase();
        const palavrasEncontradas = palavrasChave
          .filter(p => textoLower.includes(p.palavra.toLowerCase()))
          .map(p => p.palavra);

        // Salvar mensagem no banco
        try {
          db.prepare(`
            INSERT INTO chat_mensagens (cnpjOrgao, ano, sequencial, remetente, mensagem, dataHoraMensagem, hashMensagem, temCnpjFornecedor, palavrasChaveEncontradas, notificado)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            participacao.uasg || licitacaoId,
            participacao.ano || 0,
            participacao.numero || 0,
            msg.remetente,
            msg.texto,
            msg.hora,
            hashMensagem,
            temCnpj ? 1 : 0,
            palavrasEncontradas.length > 0 ? palavrasEncontradas.join(',') : null,
            0
          );
        } catch (e) {
          // Mensagem já existe (race condition)
          continue;
        }

        this.totalMensagensNovas++;

        // Notificar se tiver CNPJ ou palavras-chave
        if (temCnpj || palavrasEncontradas.length > 0) {
          let emoji = '🔔';
          let titulo = 'NOVA MENSAGEM NO CHAT';

          if (temCnpj) {
            emoji = '🚨';
            titulo = 'SEU CNPJ FOI CITADO!';
          } else if (palavrasEncontradas.length > 0) {
            emoji = '⚠️';
            titulo = 'ALERTA - PALAVRA-CHAVE';
          }

          this.log(`${emoji} ${titulo}: ${msg.texto.substring(0, 50)}...`);

          // Destacar palavras-chave na mensagem
          let mensagemFormatada = msg.texto;
          for (const palavra of palavrasEncontradas) {
            const regex = new RegExp(`(${palavra})`, 'gi');
            mensagemFormatada = mensagemFormatada.replace(regex, '<b>[$1]</b>');
          }

          // Destacar CNPJ se encontrado
          if (temCnpj && this.cnpjFornecedor) {
            mensagemFormatada = mensagemFormatada.replace(
              new RegExp(this.cnpjFornecedor, 'g'),
              `<b>[${this.cnpjFornecedor}]</b>`
            );
          }

          // Montar alerta
          let alertaTelegram = `${emoji} <b>${titulo}</b>\n\n`;
          alertaTelegram += `<b>Licitação:</b> ${licitacaoDisplay}\n`;
          if (participacao.orgao) {
            alertaTelegram += `<b>Órgão:</b> ${participacao.orgao}\n`;
          }
          alertaTelegram += `\n<b>📩 Mensagem do ${msg.remetente}:</b>\n`;
          alertaTelegram += `<i>${mensagemFormatada.substring(0, 800)}</i>`;

          if (palavrasEncontradas.length > 0) {
            alertaTelegram += `\n\n<b>🔑 Palavras:</b> ${palavrasEncontradas.join(', ')}`;
          }

          // Não adicionar link direto pois usamos navegação por clique agora
          alertaTelegram += `\n\n📎 <i>Acesse o Comprasnet para ver detalhes</i>`;

          await enviarTelegram(alertaTelegram);

          // Marcar como notificado
          db.prepare('UPDATE chat_mensagens SET notificado = 1 WHERE hashMensagem = ?').run(hashMensagem);
        }
      }

    } catch (error) {
      this.log('Erro ao extrair mensagens: ' + error.message);
      console.error('Stack trace:', error);
    }
  }

  async verificarMensagens() {
    // Método mantido para compatibilidade, chama o novo método
    await this.verificarMensagensLicitacao();
  }

  async parar() {
    this.ativo = false;

    if (this.intervalo) {
      clearInterval(this.intervalo);
      this.intervalo = null;
    }

    if (this.browser) {
      try {
        await this.browser.close();
      } catch (e) {}
      this.browser = null;
      this.page = null;
    }

    this.log('Monitoramento parado');
    await enviarTelegram('🔴 <b>Monitor de Mensagens Parado</b>');
  }

  getStatus() {
    return {
      ativo: this.ativo,
      ultimaVerificacao: this.ultimaVerificacao,
      totalMensagensNovas: this.totalMensagensNovas,
      logs: this.logs.slice(-30)
    };
  }
}

// Classe MonitorChat mantida para compatibilidade (código legado)
class MonitorChat {
  constructor(cnpj, ano, sequencial, linkSistema) {
    this.cnpj = cnpj;
    this.ano = ano;
    this.sequencial = sequencial;
    this.linkSistema = linkSistema;
    this.browser = null;
    this.page = null;
    this.ativo = false;
    this.intervalo = null;
    this.mensagensProcessadas = new Set();
    this.logs = [];
  }

  log(mensagem) {
    const timestamp = new Date().toLocaleTimeString('pt-BR');
    const logEntry = `[${timestamp}] ${mensagem}`;
    this.logs.push(logEntry);
    console.log(`[Monitor ${this.cnpj}/${this.ano}/${this.sequencial}] ${mensagem}`);
    // Manter apenas últimos 100 logs
    if (this.logs.length > 100) this.logs.shift();
  }

  async iniciar() {
    try {
      this.log('Iniciando monitoramento...');

      // Verificar se há certificado digital configurado
      const cert = db.prepare('SELECT certificadoBase64, senhaCriptografada, titular FROM certificado_digital WHERE id = 1').get();
      const usarCertificado = !!cert;

      if (usarCertificado) {
        this.log('Certificado digital encontrado - usando login com certificado');
      } else {
        this.log('Certificado não encontrado - usando login com CPF/senha');
      }

      // Buscar credenciais (fallback se certificado falhar)
      const usuario = db.prepare("SELECT valor FROM config WHERE chave = 'comprasnet_usuario'").get();
      const senha = db.prepare("SELECT valor FROM config WHERE chave = 'comprasnet_senha'").get();

      if (!usarCertificado && (!usuario || !senha)) {
        throw new Error('Credenciais do Comprasnet não configuradas e certificado não disponível');
      }

      // Verificar configuração de proxy
      const proxyAtivo = db.prepare(`SELECT valor FROM config WHERE chave = 'proxy_ativo'`).get();
      const proxyServidor = db.prepare(`SELECT valor FROM config WHERE chave = 'proxy_servidor'`).get();
      const proxyPorta = db.prepare(`SELECT valor FROM config WHERE chave = 'proxy_porta'`).get();
      const proxyUsuario = db.prepare(`SELECT valor FROM config WHERE chave = 'proxy_usuario'`).get();
      const proxySenha = db.prepare(`SELECT valor FROM config WHERE chave = 'proxy_senha'`).get();

      // Preparar certificado se necessário
      let certTempPath = null;
      let certSenha = null;
      if (usarCertificado) {
        const os = require('os');
        const fs = require('fs');
        const { execSync } = require('child_process');

        certTempPath = path.join(os.tmpdir(), `cert_${Date.now()}.pfx`);
        const certBuffer = Buffer.from(cert.certificadoBase64, 'base64');
        certSenha = Buffer.from(cert.senhaCriptografada, 'base64').toString();
        fs.writeFileSync(certTempPath, certBuffer);
        this.log('Certificado salvo em arquivo temporário');

        // Verificar se o certificado já está instalado no Windows
        let certInstalado = false;
        try {
          const result = execSync('certutil -store -user My', { encoding: 'utf8', stdio: 'pipe' });
          if (result.includes(cert.titular.split(':')[0])) {
            certInstalado = true;
            this.log('Certificado já está instalado no Windows');
          }
        } catch (e) {}

        // Tentar instalar certificado no Windows Certificate Store (precisa de admin)
        if (!certInstalado) {
          try {
            execSync(`certutil -f -p "${certSenha}" -user -importpfx "${certTempPath}"`, { stdio: 'pipe' });
            this.log('Certificado instalado no Windows Certificate Store');
            certInstalado = true;
          } catch (e) {
            this.log('ATENÇÃO: Não foi possível instalar o certificado automaticamente.');
            this.log('Para usar login com certificado, execute como Administrador OU instale o certificado manualmente:');
            this.log(`  1. Clique duas vezes no arquivo: ${certTempPath}`);
            this.log('  2. Siga o assistente de importação');
            this.log('  3. Use a senha do certificado quando solicitado');
            this.log('Tentando login com CPF/senha como alternativa...');
            // Não usar certificado se não está instalado
            // Continuar com CPF/senha
          }
        }

        // Limpar arquivo temporário se certificado foi instalado
        if (certInstalado) {
          try { fs.unlinkSync(certTempPath); } catch (e) {}
        }

        // Atualizar flag para refletir se certificado pode ser usado
        if (!certInstalado) {
          this.log('Certificado não instalado - login será feito com CPF/senha');
        }
        // Guardar estado do certificado
        this.certInstalado = certInstalado;
      }

      // Flag final para saber se pode usar certificado
      const podUsarCertificado = usarCertificado && this.certInstalado;

      // Configurar argumentos do navegador
      const browserArgs = [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process',
        '--ignore-certificate-errors',
        '--disable-blink-features=AutomationControlled',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-sync',
        '--disable-default-apps',
        '--mute-audio',
        '--disable-infobars',
        '--window-size=1366,768'
      ];

      // Auto-selecionar certificado para gov.br
      if (podUsarCertificado) {
        browserArgs.push('--auto-select-certificate-for-urls={"pattern":"*gov.br*","filter":{}}');
      }

      // Adicionar proxy se configurado
      if (proxyAtivo?.valor === '1' && proxyServidor?.valor && proxyPorta?.valor) {
        const proxyUrl = `${proxyServidor.valor}:${proxyPorta.valor}`;
        browserArgs.push(`--proxy-server=${proxyUrl}`);
        this.log(`Usando proxy: ${proxyUrl}`);
      }

      // Iniciar navegador
      this.browser = await puppeteer.launch({
        headless: false, // Visível para debug
        defaultViewport: { width: 1366, height: 768 },
        args: browserArgs
      });

      this.page = await this.browser.newPage();
      this.page.setDefaultTimeout(90000);

      // Configurar autenticação do proxy se necessário
      if (proxyAtivo?.valor === '1' && proxyUsuario?.valor && proxySenha?.valor) {
        await this.page.authenticate({
          username: proxyUsuario.valor,
          password: proxySenha.valor
        });
        this.log('Autenticação de proxy configurada');
      }

      // Configurar user-agent para evitar bloqueios
      await this.page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

      // Fazer login no gov.br
      this.log('Acessando página de login gov.br...');
      await this.page.goto('https://sso.acesso.gov.br/login', { waitUntil: 'domcontentloaded', timeout: 90000 });

      // Aguardar o carregamento do React/JavaScript (até 2 minutos)
      this.log('Aguardando carregamento da página...');
      try {
        await this.page.waitForFunction(() => {
          return document.body.innerText.length > 100;
        }, { timeout: 120000 }); // 2 minutos
      } catch (e) {
        this.log('Página ainda não carregou completamente, tentando continuar...');
      }

      // Se pode usar certificado, clicar na opção de certificado digital
      if (podUsarCertificado) {
        this.log('Procurando opção de login com certificado digital...');
        await new Promise(r => setTimeout(r, 2000));

        // Procurar link/botão de certificado digital
        const seletoresCertificado = [
          'a[href*="certificado"]',
          'button:has-text("certificado")',
          '[class*="certificado"]',
          'a:has-text("certificado digital")',
          'div[role="button"]:has-text("certificado")'
        ];

        let certLink = null;

        // Tentar encontrar por texto
        try {
          const links = await this.page.$$('a, button, div[role="button"]');
          for (const link of links) {
            const texto = await link.evaluate(el => el.innerText.toLowerCase());
            if (texto.includes('certificado digital') || texto.includes('seu certificado')) {
              certLink = link;
              this.log('Link de certificado encontrado');
              break;
            }
          }
        } catch (e) {}

        if (certLink) {
          await certLink.click();
          this.log('Clicou no login com certificado digital');
          await new Promise(r => setTimeout(r, 5000));

          // Aguardar redirecionamento ou seleção de certificado
          // O Chrome deve auto-selecionar o certificado configurado
          await this.page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {});

          const urlAtual = this.page.url();
          this.log(`URL após certificado: ${urlAtual}`);

          // Verificar se login foi bem sucedido
          if (!urlAtual.includes('login') && !urlAtual.includes('acesso.gov.br')) {
            this.log('Login com certificado realizado com sucesso!');
          } else {
            this.log('Login com certificado pode ter falhado, verificando página...');
          }
        } else {
          this.log('Link de certificado não encontrado, tentando login com CPF/senha...');
        }

        // Limpar arquivo temporário
        if (certTempPath) {
          try {
            require('fs').unlinkSync(certTempPath);
          } catch (e) {}
        }
      }

      // Se não usou certificado ou falhou, tentar CPF/senha
      const urlAtual = this.page.url();
      if (urlAtual.includes('login') || urlAtual.includes('acesso.gov.br')) {
        if (!usuario || !senha) {
          throw new Error('Login com certificado falhou e credenciais CPF/senha não configuradas');
        }

        this.log('Tentando login com CPF/senha...');

        // Seletores possíveis para o campo de CPF
        const seletoresCPF = [
          'input[name="accountId"]',
          'input[id="accountId"]',
          'input[type="text"]',
          'input[placeholder*="CPF"]',
          'input[aria-label*="CPF"]'
        ];

        let cpfInput = null;
        for (const seletor of seletoresCPF) {
          try {
            cpfInput = await this.page.$(seletor);
            if (cpfInput) {
              this.log(`Campo CPF encontrado: ${seletor}`);
              break;
            }
          } catch (e) { continue; }
        }

        if (!cpfInput) {
          throw new Error('Campo de CPF não encontrado na página de login');
        }

        // Preencher CPF
        this.log('Preenchendo CPF...');
        await cpfInput.click();
        await cpfInput.type(usuario.valor, { delay: 50 });

        // Clicar no botão de continuar
        const seletoresBotao = [
          'button[type="submit"]',
          'button[data-testid="enter-account-id"]',
          'button.primary',
          'button:not([disabled])'
        ];

        let botao = null;
        for (const seletor of seletoresBotao) {
          try {
            botao = await this.page.$(seletor);
            if (botao) break;
          } catch (e) { continue; }
        }

        if (botao) {
          await botao.click();
        } else {
          await this.page.keyboard.press('Enter');
        }

        this.log('CPF enviado, aguardando próxima etapa...');
        await new Promise(r => setTimeout(r, 3000)); // Aguardar transição

        // Aguardar campo de senha (pode demorar)
        const seletoresSenha = [
          'input[name="password"]',
          'input[type="password"]',
          'input[id="password"]',
          'input[aria-label*="senha"]'
        ];

        let senhaInput = null;
        for (let tentativa = 0; tentativa < 10 && !senhaInput; tentativa++) {
          for (const seletor of seletoresSenha) {
            try {
              senhaInput = await this.page.$(seletor);
              if (senhaInput) {
                this.log(`Campo senha encontrado: ${seletor}`);
                break;
              }
            } catch (e) { continue; }
          }
          if (!senhaInput) {
            await new Promise(r => setTimeout(r, 2000));
          }
        }

        if (!senhaInput) {
          // Pode ser que o gov.br pediu verificação por celular/email
          const pageContent = await this.page.content();
          const pageText = await this.page.evaluate(() => document.body.innerText);
          const urlAtualSenha = this.page.url();
          this.log(`URL atual após CPF: ${urlAtualSenha}`);

          // Capturar título e texto visível para debug
          const titulo = await this.page.title();
          this.log(`Título da página: ${titulo}`);

          // Verificar se o campo de senha pode aparecer em outro formato
          const passwordField = await this.page.$('input[type="password"]');
          if (passwordField) {
            senhaInput = passwordField;
            this.log('Campo de senha encontrado por type="password"');
          } else {
            // Verificar mensagens específicas de erro
            if (pageText.includes('código de acesso') || pageText.includes('verificação') || pageText.includes('enviamos um código')) {
              throw new Error('Login requer verificação por código (celular/email). Faça login manualmente primeiro no gov.br.');
            }
            if (pageText.includes('não encontrado') || pageText.includes('não cadastrado') || pageText.includes('CPF inválido')) {
              throw new Error('CPF não encontrado ou inválido no gov.br.');
            }
            if (pageText.includes('bloqueado') || pageText.includes('suspenso')) {
              throw new Error('Conta gov.br bloqueada ou suspensa.');
            }

            // Log do texto visível para debug
            this.log(`Texto na página: ${pageText.substring(0, 500)}...`);
            throw new Error('Campo de senha não apareceu. A página pode estar pedindo verificação adicional ou as credenciais estão incorretas.');
          }
        }

        // Preencher senha
        this.log('Preenchendo senha...');
        await senhaInput.click();
        await senhaInput.type(senha.valor, { delay: 50 });

        // Clicar no botão de login
        await new Promise(r => setTimeout(r, 500));
        const botaoLogin = await this.page.$('button[type="submit"]');
        if (botaoLogin) {
          await botaoLogin.click();
        } else {
          await this.page.keyboard.press('Enter');
        }

        this.log('Login realizado, aguardando redirecionamento...');
        await this.page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {});
        await new Promise(r => setTimeout(r, 3000));

        // Verificar se login foi bem sucedido
        const urlFinal = this.page.url();
        if (urlFinal.includes('login') || urlFinal.includes('acesso.gov.br')) {
          const pageContent = await this.page.content();
          if (pageContent.includes('incorret') || pageContent.includes('inválid')) {
            throw new Error('CPF ou senha incorretos');
          }
        }
      }

      // Navegar para o link do sistema
      if (this.linkSistema && this.linkSistema.trim() && !this.linkSistema.includes('sigep')) {
        this.log('Acessando sessão da licitação...');
        const linkCompleto = this.linkSistema.startsWith('http') ? this.linkSistema : `https://${this.linkSistema}`;
        await this.page.goto(linkCompleto, { waitUntil: 'networkidle2', timeout: 60000 });
      }

      this.ativo = true;
      this.log('Monitoramento iniciado com sucesso!');

      // Enviar notificação
      await enviarTelegram(`🟢 <b>Monitoramento iniciado</b>\n\nLicitação: ${this.cnpj}/${this.ano}/${this.sequencial}`);

      // Iniciar loop de verificação
      this.iniciarVerificacao();

      return { success: true };
    } catch (error) {
      this.log('Erro ao iniciar: ' + error.message);
      await this.parar();
      throw error;
    }
  }

  iniciarVerificacao() {
    // Verificar chat a cada 5 segundos
    this.intervalo = setInterval(async () => {
      if (!this.ativo) return;

      try {
        await this.verificarChat();
      } catch (error) {
        this.log('Erro na verificação: ' + error.message);
      }
    }, 5000);
  }

  async verificarChat() {
    try {
      // Tentar encontrar mensagens do chat
      // Seletores podem variar dependendo do sistema (Comprasnet, ComprasGov, etc)
      const seletoresChat = [
        '.chat-mensagem',
        '.mensagem-chat',
        '[class*="chat"] [class*="message"]',
        '.message-content',
        '#chat-container .message',
        '.chat-item',
        '.msg-item'
      ];

      let mensagens = [];

      for (const seletor of seletoresChat) {
        try {
          mensagens = await this.page.$$(seletor);
          if (mensagens.length > 0) break;
        } catch (e) {
          continue;
        }
      }

      if (mensagens.length === 0) {
        // Tentar buscar por iframe do chat
        const frames = this.page.frames();
        for (const frame of frames) {
          try {
            for (const seletor of seletoresChat) {
              mensagens = await frame.$$(seletor);
              if (mensagens.length > 0) break;
            }
            if (mensagens.length > 0) break;
          } catch (e) {
            continue;
          }
        }
      }

      // Processar mensagens encontradas
      for (const msg of mensagens) {
        try {
          const texto = await msg.evaluate(el => el.innerText);
          const msgId = await msg.evaluate(el => el.getAttribute('data-id') || el.innerText.substring(0, 50));

          if (!this.mensagensProcessadas.has(msgId)) {
            this.mensagensProcessadas.add(msgId);

            // Extrair remetente e conteúdo
            let remetente = 'Pregoeiro';
            let conteudo = texto;

            // Tentar separar remetente do conteúdo
            const partes = texto.split(':');
            if (partes.length > 1) {
              remetente = partes[0].trim();
              conteudo = partes.slice(1).join(':').trim();
            }

            // Ignorar mensagens do próprio fornecedor
            if (remetente.toLowerCase().includes('fornecedor')) continue;

            this.log(`Nova mensagem de ${remetente}: ${conteudo.substring(0, 50)}...`);

            // Verificar palavras-chave
            const palavrasChave = db.prepare('SELECT palavra FROM chat_palavras_chave WHERE ativo = 1').all();
            const conteudoLower = conteudo.toLowerCase();
            const palavrasEncontradas = palavrasChave
              .filter(p => conteudoLower.includes(p.palavra.toLowerCase()))
              .map(p => p.palavra);

            // Definir emoji e urgência baseado nas palavras-chave
            let emoji = '🔔';
            let tipoAlerta = 'NOVA MENSAGEM NO CHAT';
            if (palavrasEncontradas.length > 0) {
              emoji = '🚨';
              tipoAlerta = 'ALERTA IMPORTANTE - PALAVRA-CHAVE DETECTADA';
              this.log(`⚠️ Palavras-chave detectadas: ${palavrasEncontradas.join(', ')}`);
            }

            // Enviar alerta
            let mensagemTelegram = `${emoji} <b>${tipoAlerta}</b>\n\n` +
              `<b>Licitação:</b> ${this.cnpj}/${this.ano}/${this.sequencial}\n\n` +
              `<b>De:</b> ${remetente}\n` +
              `<b>Mensagem:</b>\n${conteudo}`;

            if (palavrasEncontradas.length > 0) {
              mensagemTelegram += `\n\n⚠️ <b>Palavras-chave:</b> ${palavrasEncontradas.join(', ')}`;
            }

            await enviarTelegram(mensagemTelegram);

            // Salvar no banco
            db.prepare(`
              INSERT INTO chat_mensagens (cnpj, ano, sequencial, mensagemId, remetente, conteudo, dataHora, notificado)
              VALUES (?, ?, ?, ?, ?, ?, datetime('now'), 1)
            `).run(this.cnpj, this.ano, this.sequencial, msgId, remetente, conteudo);
          }
        } catch (e) {
          continue;
        }
      }
    } catch (error) {
      this.log('Erro ao verificar chat: ' + error.message);
    }
  }

  async parar() {
    this.ativo = false;

    if (this.intervalo) {
      clearInterval(this.intervalo);
      this.intervalo = null;
    }

    if (this.browser) {
      try {
        await this.browser.close();
      } catch (e) {}
      this.browser = null;
      this.page = null;
    }

    this.log('Monitoramento parado');
    await enviarTelegram(`🔴 <b>Monitoramento parado</b>\n\nLicitação: ${this.cnpj}/${this.ano}/${this.sequencial}`);
  }

  getStatus() {
    return {
      ativo: this.ativo,
      logs: this.logs.slice(-20)
    };
  }
}

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

// ==================== PALAVRAS-CHAVE DE ALERTA ====================

// Listar palavras-chave
app.get('/api/chat/palavras-chave', (req, res) => {
  try {
    const palavras = db.prepare('SELECT * FROM chat_palavras_chave ORDER BY palavra').all();
    res.json({ success: true, data: palavras });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Adicionar palavra-chave
app.post('/api/chat/palavras-chave', (req, res) => {
  try {
    const { palavra } = req.body;
    if (!palavra || palavra.trim().length < 2) {
      return res.status(400).json({ success: false, error: 'Palavra deve ter pelo menos 2 caracteres' });
    }
    db.prepare('INSERT OR IGNORE INTO chat_palavras_chave (palavra) VALUES (?)').run(palavra.trim().toLowerCase());
    res.json({ success: true, message: 'Palavra-chave adicionada' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Remover palavra-chave
app.delete('/api/chat/palavras-chave/:id', (req, res) => {
  try {
    const { id } = req.params;
    db.prepare('DELETE FROM chat_palavras_chave WHERE id = ?').run(id);
    res.json({ success: true, message: 'Palavra-chave removida' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});
// ==================== SESSÃO DE MONITORAMENTO (EXTENSÃO) ====================

// Obter sessão de monitoramento ativa
app.get('/api/chat/monitoramento/sessao', (req, res) => {
  try {
    const sessao = db.prepare('SELECT * FROM monitoramento_sessao WHERE ativo = 1 ORDER BY dataAtualizacao DESC LIMIT 1').get();
    if (sessao) {
      sessao.licitacoesProcessadas = JSON.parse(sessao.licitacoesProcessadas || '[]');
    }
    res.json({ success: true, data: sessao || null });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Salvar progresso da sessão de monitoramento
app.post('/api/chat/monitoramento/sessao', (req, res) => {
  try {
    const { statusAtual, paginaAtual, indiceLicitacao, totalLicitacoes, licitacoesProcessadas } = req.body;

    // Desativa sessões anteriores
    db.prepare('UPDATE monitoramento_sessao SET ativo = 0').run();

    // Insere nova sessão
    db.prepare(`
      INSERT INTO monitoramento_sessao (statusAtual, paginaAtual, indiceLicitacao, totalLicitacoes, licitacoesProcessadas, ativo, dataAtualizacao)
      VALUES (?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
    `).run(
      statusAtual || 'Em andamento',
      paginaAtual || 1,
      indiceLicitacao || 0,
      totalLicitacoes || 0,
      JSON.stringify(licitacoesProcessadas || [])
    );

    console.log('[Sessão] Progresso salvo: ' + statusAtual + ', lic ' + indiceLicitacao + '/' + totalLicitacoes);
    res.json({ success: true, message: 'Sessão salva' });
  } catch (error) {
    console.error('[Sessão] Erro ao salvar:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Limpar sessão de monitoramento
app.delete('/api/chat/monitoramento/sessao', (req, res) => {
  try {
    db.prepare('UPDATE monitoramento_sessao SET ativo = 0').run();
    console.log('[Sessão] Sessão encerrada');
    res.json({ success: true, message: 'Sessão encerrada' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Verificar se licitação já foi capturada completamente
app.get('/api/chat/captura/verificar/:compraId', (req, res) => {
  try {
    const { compraId } = req.params;
    const progresso = db.prepare('SELECT capturaCompleta, totalMensagensCapturadas FROM chat_captura_progresso WHERE compraId = ?').get(compraId);

    if (progresso && progresso.capturaCompleta) {
      res.json({ success: true, capturada: true, totalMensagens: progresso.totalMensagensCapturadas });
    } else {
      res.json({ success: true, capturada: false });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Listar licitações já capturadas (para pular)
app.get('/api/chat/captura/completas', (req, res) => {
  try {
    const completas = db.prepare('SELECT compraId FROM chat_captura_progresso WHERE capturaCompleta = 1').all();
    res.json({ success: true, data: completas.map(c => c.compraId) });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});



// Marcar mensagem como lida (rota que funciona)
app.post('/api/chat/leitura/marcar', (req, res) => {
  try {
    const { id } = req.body;
    const agora = new Date().toISOString();
    db.prepare('UPDATE chat_mensagens SET lido = 1, dataLeitura = ? WHERE id = ?').run(agora, id);
    console.log(`[Chat] Mensagem ${id} marcada como lida`);
    res.json({ success: true, message: 'Mensagem marcada como lida' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Marcar todas mensagens como lidas
app.post('/api/chat/leitura/marcar-todas', (req, res) => {
  try {
    const { cnpjOrgao, ano, sequencial } = req.body;
    const agora = new Date().toISOString();

    if (cnpjOrgao && ano && sequencial) {
      db.prepare('UPDATE chat_mensagens SET lido = 1, dataLeitura = ? WHERE cnpjOrgao = ? AND ano = ? AND sequencial = ? AND (lido = 0 OR lido IS NULL)')
        .run(agora, cnpjOrgao, parseInt(ano), parseInt(sequencial));
    } else {
      db.prepare('UPDATE chat_mensagens SET lido = 1, dataLeitura = ? WHERE lido = 0 OR lido IS NULL').run(agora);
    }

    res.json({ success: true, message: 'Mensagens marcadas como lidas' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== ROTAS DE LICITAÇÕES A MONITORAR ====================

// Listar licitações a monitorar
app.get('/api/chat/licitacoes-monitorar', (req, res) => {
  try {
    const licitacoes = db.prepare('SELECT * FROM licitacoes_monitorar ORDER BY dataCriacao DESC').all();
    res.json({ success: true, data: licitacoes });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Adicionar licitação para monitorar
app.post('/api/chat/licitacoes-monitorar', (req, res) => {
  try {
    const { cnpjOrgao, ano, sequencial, descricao, urlCompra } = req.body;

    if (!cnpjOrgao || !ano || !sequencial) {
      return res.status(400).json({ success: false, error: 'CNPJ, ano e sequencial são obrigatórios' });
    }

    db.prepare(`
      INSERT OR REPLACE INTO licitacoes_monitorar (cnpjOrgao, ano, sequencial, descricao, urlCompra, ativo)
      VALUES (?, ?, ?, ?, ?, 1)
    `).run(cnpjOrgao, ano, sequencial, descricao || '', urlCompra || '');

    res.json({ success: true, message: 'Licitação adicionada para monitoramento' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Adicionar licitação a partir de URL do Comprasnet
app.post('/api/chat/licitacoes-monitorar/url', (req, res) => {
  try {
    const { url, descricao } = req.body;

    if (!url) {
      return res.status(400).json({ success: false, error: 'URL é obrigatória' });
    }

    // Tentar extrair dados da URL
    // Formato padrão: compra=CNPJ(14)+SEQUENCIAL(5)+ANO(4) = 23 dígitos
    // Formato antigo: compra=UASG+NUMERO = menos dígitos
    let cnpjOrgao, sequencial, ano;

    // Tentar formato completo (23 dígitos)
    let match = url.match(/compra=(\d{14})(\d{5})(\d{4})/);
    if (match) {
      cnpjOrgao = match[1];
      sequencial = parseInt(match[2], 10);
      ano = parseInt(match[3], 10);
    } else {
      // Tentar formato alternativo - extrair qualquer código numérico
      match = url.match(/compra=(\d+)/);
      if (!match) {
        return res.status(400).json({ success: false, error: 'URL inválida. Não foi possível extrair o código da compra.' });
      }
      const codigo = match[1];
      // Usar o código como identificador único
      cnpjOrgao = codigo.substring(0, Math.max(8, codigo.length - 7)); // Primeiros dígitos como "CNPJ/UASG"
      const resto = codigo.substring(cnpjOrgao.length);
      sequencial = resto.length >= 6 ? parseInt(resto.substring(0, resto.length - 4), 10) : parseInt(resto.substring(0, 2) || '1', 10);
      ano = resto.length >= 4 ? parseInt(resto.substring(resto.length - 4), 10) : new Date().getFullYear();
    }

    db.prepare(`
      INSERT OR REPLACE INTO licitacoes_monitorar (cnpjOrgao, ano, sequencial, descricao, urlCompra, ativo)
      VALUES (?, ?, ?, ?, ?, 1)
    `).run(cnpjOrgao, ano, sequencial, descricao || '', url);

    res.json({
      success: true,
      message: 'Licitação adicionada para monitoramento',
      data: { cnpjOrgao, ano, sequencial }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Remover licitação do monitoramento
app.delete('/api/chat/licitacoes-monitorar/:id', (req, res) => {
  try {
    const { id } = req.params;
    db.prepare('DELETE FROM licitacoes_monitorar WHERE id = ?').run(id);
    res.json({ success: true, message: 'Licitação removida do monitoramento' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Ativar/desativar licitação
app.patch('/api/chat/licitacoes-monitorar/:id', (req, res) => {
  try {
    const { id } = req.params;
    const { ativo } = req.body;
    db.prepare('UPDATE licitacoes_monitorar SET ativo = ? WHERE id = ?').run(ativo ? 1 : 0, id);
    res.json({ success: true, message: 'Status atualizado' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== ROTAS DE MENSAGENS CAPTURADAS ====================

// Contar mensagens não lidas (DEVE vir antes da rota com parâmetros)
app.get('/api/chat/mensagens/nao-lidas', (req, res) => {
  try {
    const result = db.prepare('SELECT COUNT(*) as total FROM chat_mensagens WHERE lido = 0 OR lido IS NULL').get();
    res.json({ success: true, total: result.total || 0 });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Marcar mensagem específica como lida
app.post('/api/chat/mensagens/marcar-lida', (req, res) => {
  try {
    const { id } = req.body;
    const agora = new Date().toISOString();
    db.prepare('UPDATE chat_mensagens SET lido = 1, dataLeitura = ? WHERE id = ?').run(agora, id);
    console.log(`[Chat] Mensagem ${id} marcada como lida`);
    res.json({ success: true, message: 'Mensagem marcada como lida' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Marcar todas mensagens como lidas
app.post('/api/chat/mensagens/marcar-todas-lidas', (req, res) => {
  try {
    const { cnpjOrgao, ano, sequencial } = req.body;
    const agora = new Date().toISOString();

    if (cnpjOrgao && ano && sequencial) {
      db.prepare('UPDATE chat_mensagens SET lido = 1, dataLeitura = ? WHERE cnpjOrgao = ? AND ano = ? AND sequencial = ? AND (lido = 0 OR lido IS NULL)')
        .run(agora, cnpjOrgao, parseInt(ano), parseInt(sequencial));
    } else {
      db.prepare('UPDATE chat_mensagens SET lido = 1, dataLeitura = ? WHERE lido = 0 OR lido IS NULL').run(agora);
    }

    res.json({ success: true, message: 'Mensagens marcadas como lidas' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Listar mensagens capturadas (histórico)
app.get('/api/chat/mensagens', (req, res) => {
  try {
    const { cnpjOrgao, ano, sequencial, tipo, data, busca, limit = 100, action } = req.query;

    // Ação especial: contar não lidas
    if (action === 'count-unread') {
      const result = db.prepare('SELECT COUNT(*) as total FROM chat_mensagens WHERE lido = 0 OR lido IS NULL').get();
      return res.json({ success: true, total: result ? result.total : 0 });
    }

    let sql = 'SELECT * FROM chat_mensagens WHERE 1=1';
    const params = [];

    // Filtro por órgão (mesmo sem ano/sequencial)
    if (cnpjOrgao) {
      sql += ' AND cnpjOrgao = ?';
      params.push(cnpjOrgao);
    }

    // Filtro por licitação específica
    if (ano && sequencial) {
      sql += ' AND ano = ? AND sequencial = ?';
      params.push(parseInt(ano), parseInt(sequencial));
    }

    // Filtro por tipo
    if (tipo === 'alerta') {
      sql += ' AND palavrasChaveEncontradas IS NOT NULL AND palavrasChaveEncontradas != ""';
    } else if (tipo === 'para-mim') {
      // Mensagens direcionadas especificamente ao fornecedor
      let meuCnpj = '';
      try {
        const f = db.prepare('SELECT cnpj FROM fornecedor WHERE id = 1').get();
        meuCnpj = (f?.cnpj || '').replace(/\D/g, '');
      } catch(e) {}
      if (meuCnpj) {
        sql += ' AND identificadorDestinatario = ?';
        params.push(meuCnpj);
      }
    } else if (tipo === 'cnpj') {
      // Mensagens direcionadas ao fornecedor (por identificadorDestinatario ou temCnpjFornecedor)
      let meuCnpj = '';
      try {
        const f = db.prepare('SELECT cnpj FROM fornecedor WHERE id = 1').get();
        meuCnpj = (f?.cnpj || '').replace(/\D/g, '');
      } catch(e) {}
      if (meuCnpj) {
        sql += ' AND (temCnpjFornecedor = 1 OR identificadorDestinatario = ?)';
        params.push(meuCnpj);
      } else {
        sql += ' AND temCnpjFornecedor = 1';
      }
    }

    // Filtro por data
    if (data === 'hoje') {
      sql += " AND date(dataCaptura) = date('now')";
    } else if (data === '7dias') {
      sql += " AND date(dataCaptura) >= date('now', '-7 days')";
    } else if (data === '30dias') {
      sql += " AND date(dataCaptura) >= date('now', '-30 days')";
    }

    // Filtro por busca de texto
    if (busca && busca.trim()) {
      sql += ' AND (mensagem LIKE ? OR remetente LIKE ?)';
      const buscaTermo = `%${busca.trim()}%`;
      params.push(buscaTermo, buscaTermo);
    }

    sql += ' ORDER BY dataHoraMensagem DESC, id DESC LIMIT ?';
    params.push(parseInt(limit));

    const mensagens = db.prepare(sql).all(...params);
    res.json({ success: true, data: mensagens, total: mensagens.length });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Listar licitações distintas com mensagens (para filtro)
app.get('/api/chat/mensagens/licitacoes', (req, res) => {
  try {
    const licitacoes = db.prepare(`
      SELECT
        cm.compraId,
        COUNT(*) as totalMensagens,
        MAX(cm.dataHoraMensagem) as ultimaMensagem,
        p.orgao as nomeOrgao,
        p.codigoUnidade as uasg,
        p.ano,
        p.sequencial,
        p.cnpj as cnpjOrgao
      FROM chat_mensagens cm
      LEFT JOIN participacoes_comprasnet p ON cm.compraId = p.compraId
      WHERE cm.compraId IS NOT NULL AND cm.compraId != ''
      GROUP BY cm.compraId
      ORDER BY ultimaMensagem DESC
    `).all();

    res.json({ success: true, data: licitacoes });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Listar órgãos distintos com mensagens
app.get('/api/chat/mensagens/orgaos', (req, res) => {
  try {
    const orgaos = db.prepare(`
      SELECT
        p.orgao as nomeOrgao,
        p.cnpj as cnpjOrgao,
        p.codigoUnidade as uasg,
        COUNT(DISTINCT cm.compraId) as totalLicitacoes,
        COUNT(*) as totalMensagens
      FROM chat_mensagens cm
      INNER JOIN participacoes_comprasnet p ON cm.compraId = p.compraId
      WHERE cm.compraId IS NOT NULL AND cm.compraId != ''
      GROUP BY p.cnpj
      ORDER BY totalMensagens DESC
    `).all();

    res.json({ success: true, data: orgaos });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Estatísticas de mensagens
// Marcar mensagem como lida
app.post('/api/chat/mensagens/:id/lido', (req, res) => {
  try {
    const { id } = req.params;
    const agora = new Date().toISOString();

    db.prepare('UPDATE chat_mensagens SET lido = 1, dataLeitura = ? WHERE id = ?').run(agora, id);

    console.log(`[Chat] Mensagem ${id} marcada como lida`);
    res.json({ success: true, message: 'Mensagem marcada como lida' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Marcar todas mensagens de uma licitação como lidas
app.post('/api/chat/mensagens/lidas', (req, res) => {
  try {
    const { cnpjOrgao, ano, sequencial } = req.body;
    const agora = new Date().toISOString();

    if (cnpjOrgao && ano && sequencial) {
      db.prepare('UPDATE chat_mensagens SET lido = 1, dataLeitura = ? WHERE cnpjOrgao = ? AND ano = ? AND sequencial = ? AND lido = 0')
        .run(agora, cnpjOrgao, parseInt(ano), parseInt(sequencial));
    } else {
      // Marca todas como lidas
      db.prepare('UPDATE chat_mensagens SET lido = 1, dataLeitura = ? WHERE lido = 0').run(agora);
    }

    res.json({ success: true, message: 'Mensagens marcadas como lidas' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Contar mensagens não lidas
app.get('/api/chat/mensagens/nao-lidas', (req, res) => {
  try {
    const result = db.prepare('SELECT COUNT(*) as total FROM chat_mensagens WHERE lido = 0').get();
    res.json({ success: true, total: result.total });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/chat/mensagens/stats', (req, res) => {
  try {
    const total = db.prepare('SELECT COUNT(*) as total FROM chat_mensagens').get();
    const comCnpj = db.prepare('SELECT COUNT(*) as total FROM chat_mensagens WHERE temCnpjFornecedor = 1').get();
    const comPalavras = db.prepare('SELECT COUNT(*) as total FROM chat_mensagens WHERE palavrasChaveEncontradas IS NOT NULL').get();
    const notificadas = db.prepare('SELECT COUNT(*) as total FROM chat_mensagens WHERE notificado = 1').get();
    const hoje = db.prepare(`SELECT COUNT(*) as total FROM chat_mensagens WHERE date(dataCaptura) = date('now')`).get();

    res.json({
      success: true,
      data: {
        total: total.total,
        comCnpjCitado: comCnpj.total,
        comPalavrasChave: comPalavras.total,
        notificadas: notificadas.total,
        capturadasHoje: hoje.total
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== ROTAS DA EXTENSÃO CHROME ====================

// Status do servidor (para extensão verificar se está online)
app.get('/api/chat/status', (req, res) => {
  res.json({
    success: true,
    online: true,
    timestamp: new Date().toISOString()
  });
});

// Keep-alive da extensão (mantém sessão ativa)
app.post('/api/chat/keep-alive', (req, res) => {
  res.json({
    success: true,
    timestamp: new Date().toISOString()
  });
});

// Receber mensagens da extensão Chrome
app.post('/api/chat/mensagens/extensao', (req, res) => {
  try {
    const { licitacao, mensagens, url, timestamp } = req.body;

    // Debug: mostrar estrutura completa do que está chegando
    console.log('[Extensão Debug] ===== DADOS RECEBIDOS =====');
    console.log('[Extensão Debug] Licitação:', JSON.stringify(licitacao));
    console.log('[Extensão Debug] URL:', url);
    console.log('[Extensão Debug] Total mensagens:', mensagens?.length);
    if (mensagens && mensagens.length > 0) {
      console.log('[Extensão Debug] Primeira mensagem (campos):', Object.keys(mensagens[0]));
      console.log('[Extensão Debug] Primeira mensagem (dados):', JSON.stringify(mensagens[0]).substring(0, 200));
    }
    console.log('[Extensão Debug] ===========================');

    if (!licitacao || !mensagens || mensagens.length === 0) {
      return res.status(400).json({ success: false, error: 'Dados inválidos' });
    }

    const { cnpjOrgao, sequencial, ano, compraId } = licitacao;
    console.log(`[Extensão Debug] compraId=${compraId} cnpj=${cnpjOrgao} seq=${sequencial} ano=${ano}`);
    let inseridas = 0;
    let duplicadas = 0;

    // Palavras-chave para alerta (apenas do banco - configuradas pelo usuário)
    let palavrasChave = [];
    try {
      const palavrasDB = db.prepare('SELECT palavra FROM chat_palavras_chave WHERE ativo = 1').all();
      palavrasChave = palavrasDB.map(p => p.palavra.toLowerCase());
    } catch (e) {
      console.log('[Extensão] Erro ao buscar palavras-chave:', e.message);
    }

    // CNPJ do fornecedor configurado (busca na tabela fornecedor)
    let cnpjFornecedor = '';
    try {
      const fornecedorConfig = db.prepare('SELECT cnpj FROM fornecedor WHERE id = 1').get();
      cnpjFornecedor = fornecedorConfig?.cnpj || '';
    } catch (e) {
      cnpjFornecedor = getConfigValue('fornecedor_cnpj') || '';
    }

    // Buscar informações do órgão e licitação no banco
    let infoLicitacao = null;
    try {
      // Tenta buscar pelo cnpjOrgao (UASG) + ano + sequencial
      infoLicitacao = db.prepare(`
        SELECT razaoSocial, objetoCompra, cnpj
        FROM licitacoes
        WHERE (cnpj LIKE ? OR cnpj LIKE ?)
        AND anoCompra = ?
        AND sequencialCompra = ?
        LIMIT 1
      `).get(`${cnpjOrgao}%`, `%${cnpjOrgao}%`, parseInt(ano), parseInt(sequencial));

      // Se não encontrou, tenta buscar só pelo sequencial e ano
      if (!infoLicitacao) {
        infoLicitacao = db.prepare(`
          SELECT razaoSocial, objetoCompra, cnpj
          FROM licitacoes
          WHERE anoCompra = ? AND sequencialCompra = ?
          LIMIT 1
        `).get(parseInt(ano), parseInt(sequencial));
      }
    } catch (e) {
      console.log('[Extensão] Erro ao buscar info licitação:', e.message);
    }

    // Adicionar coluna origemCaptura se não existir
    try {
      db.exec(`ALTER TABLE chat_mensagens ADD COLUMN origemCaptura TEXT DEFAULT 'servidor'`);
    } catch (e) {
      // Coluna já existe
    }

    const insertStmt = db.prepare(`
      INSERT OR IGNORE INTO chat_mensagens (
        cnpjOrgao, ano, sequencial, remetente, mensagem, dataHoraMensagem, dataCaptura,
        temCnpjFornecedor, palavrasChaveEncontradas, notificado, origemCaptura, hashMensagem
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'extensao', ?)
    `);

    for (const msg of mensagens) {
      // Aceitar tanto 'texto' quanto 'mensagem' ou 'conteudo' como campo de texto
      const texto = msg.texto || msg.mensagem || msg.conteudo || msg.message || '';
      const textoLower = texto.toLowerCase();

      // Log para debug - ver o que está chegando
      console.log(`[Extensão Debug] Msg recebida: remetente="${msg.remetente}", texto="${texto.substring(0, 50)}...", tamanho=${texto.length}`);

      // Ignorar mensagens de erro do sistema
      if (textoLower.includes('captcha') ||
          textoLower.includes('não há mensagens') ||
          textoLower.includes('tente mais tarde') ||
          texto.length < 10) {
        console.log(`[Extensão Debug] Mensagem FILTRADA: ${texto.length < 10 ? 'muito curta' : 'palavra bloqueada'}`);
        continue;
      }

      // Verificar se menciona o CNPJ do fornecedor
      const temCnpj = cnpjFornecedor && texto.includes(cnpjFornecedor) ? 1 : 0;

      // Verificar palavras-chave
      const palavrasEncontradas = palavrasChave.filter(p => textoLower.includes(p));
      const palavrasStr = palavrasEncontradas.length > 0 ? palavrasEncontradas.join(',') : null;

      try {
        // Gerar hash único para a mensagem (inclui remetente para melhor dedup)
        const hashMensagem = crypto.createHash('md5')
          .update(`${cnpjOrgao}-${ano}-${sequencial}-${(msg.remetente || '')}-${texto.substring(0, 100)}`)
          .digest('hex');

        const result = insertStmt.run(
          cnpjOrgao,
          parseInt(ano) || new Date().getFullYear(),
          parseInt(sequencial) || 0,
          msg.remetente || 'Sistema',
          texto,
          msg.dataHora || new Date().toISOString(),
          new Date().toISOString(),
          temCnpj,
          palavrasStr,
          hashMensagem
        );

        if (result.changes > 0) {
          inseridas++;
          const lastId = result.lastInsertRowid;

          // Enviar notificação Telegram para TODAS as mensagens novas
          // Destaque especial se contém CNPJ do fornecedor ou palavras-chave
          const ehImportante = temCnpj || palavrasEncontradas.length > 0;
          console.log(`[Telegram] Enviando alerta: Lic ${sequencial}/${ano} - Importante:${ehImportante}`);

          enviarNotificacaoTelegram({
            cnpjOrgao: cnpjOrgao,
            nomeOrgao: infoLicitacao?.razaoSocial || null,
            sequencial: sequencial,
            ano: ano,
            objetoLicitacao: infoLicitacao?.objetoCompra || null,
            remetente: msg.remetente || 'Sistema',
            mensagem: texto,
            dataHoraMensagem: msg.dataHora || new Date().toISOString(),
            temCnpjFornecedor: temCnpj === 1,
            palavrasChave: palavrasEncontradas,
            ehImportante: ehImportante
          }).then(() => {
            // Marcar como notificado
            db.prepare('UPDATE chat_mensagens SET notificado = 1 WHERE id = ?').run(lastId);
            console.log(`[Telegram] Alerta enviado e marcado: ID ${lastId}`);
          }).catch(err => {
            console.log('[Telegram] Erro ao enviar notificação:', err.message);
          });
        } else {
          duplicadas++;
        }
      } catch (e) {
        duplicadas++;
      }
    }

    console.log(`[Extensão Chrome] Recebidas ${mensagens.length} mensagens, ${inseridas} novas, ${duplicadas} duplicadas`);

    res.json({
      success: true,
      message: `${inseridas} mensagem(ns) salva(s)`,
      inseridas,
      duplicadas,
      total: mensagens.length
    });
  } catch (error) {
    console.error('[Extensão Chrome] Erro:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Consultar progresso de captura de uma licitação
app.get('/api/chat/progresso/:compraId', (req, res) => {
  try {
    const { compraId } = req.params;

    const progresso = db.prepare(`
      SELECT * FROM chat_captura_progresso WHERE compraId = ?
    `).get(compraId);

    if (progresso) {
      res.json({
        success: true,
        progresso: {
          compraId: progresso.compraId,
          ultimaPagina: progresso.ultimaPaginaCapturada,
          totalPaginas: progresso.totalPaginasEncontradas,
          totalMensagens: progresso.totalMensagensCapturadas,
          capturaCompleta: progresso.capturaCompleta === 1,
          ultimaCaptura: progresso.ultimaCaptura
        }
      });
    } else {
      res.json({
        success: true,
        progresso: null,
        message: 'Nenhuma captura anterior encontrada'
      });
    }
  } catch (error) {
    console.error('[Progresso] Erro:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Atualizar progresso de captura de uma licitação
app.post('/api/chat/progresso', (req, res) => {
  try {
    const {
      compraId,
      cnpjOrgao,
      ano,
      sequencial,
      ultimaPagina,
      totalPaginas,
      totalMensagens,
      capturaCompleta
    } = req.body;

    if (!compraId) {
      return res.status(400).json({ success: false, error: 'compraId é obrigatório' });
    }

    // Upsert - atualiza se existe, insere se não existe
    db.prepare(`
      INSERT INTO chat_captura_progresso (compraId, cnpjOrgao, ano, sequencial, ultimaPaginaCapturada, totalPaginasEncontradas, totalMensagensCapturadas, capturaCompleta, ultimaCaptura, dataAtualizacao)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT(compraId) DO UPDATE SET
        ultimaPaginaCapturada = excluded.ultimaPaginaCapturada,
        totalPaginasEncontradas = excluded.totalPaginasEncontradas,
        totalMensagensCapturadas = excluded.totalMensagensCapturadas,
        capturaCompleta = excluded.capturaCompleta,
        ultimaCaptura = CURRENT_TIMESTAMP,
        dataAtualizacao = CURRENT_TIMESTAMP
    `).run(
      compraId,
      cnpjOrgao || null,
      ano || null,
      sequencial || null,
      ultimaPagina || 0,
      totalPaginas || 0,
      totalMensagens || 0,
      capturaCompleta ? 1 : 0
    );

    console.log(`[Progresso] Atualizado: ${compraId} - página ${ultimaPagina}/${totalPaginas}, ${totalMensagens} msgs, completa: ${capturaCompleta}`);

    res.json({
      success: true,
      message: 'Progresso atualizado'
    });
  } catch (error) {
    console.error('[Progresso] Erro:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Listar progresso de todas as licitações
app.get('/api/chat/progresso', (req, res) => {
  try {
    const progressos = db.prepare(`
      SELECT * FROM chat_captura_progresso
      ORDER BY dataAtualizacao DESC
      LIMIT 100
    `).all();

    res.json({
      success: true,
      total: progressos.length,
      progressos: progressos.map(p => ({
        compraId: p.compraId,
        cnpjOrgao: p.cnpjOrgao,
        ano: p.ano,
        sequencial: p.sequencial,
        ultimaPagina: p.ultimaPaginaCapturada,
        totalPaginas: p.totalPaginasEncontradas,
        totalMensagens: p.totalMensagensCapturadas,
        capturaCompleta: p.capturaCompleta === 1,
        ultimaCaptura: p.ultimaCaptura
      }))
    });
  } catch (error) {
    console.error('[Progresso] Erro:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Reset de progresso - para recapturar licitações
app.delete('/api/chat/progresso/reset-all', (req, res) => {
  try {
    const result = db.prepare(`DELETE FROM chat_captura_progresso`).run();
    console.log(`[Progresso] Reset total: ${result.changes} registros removidos`);
    res.json({
      success: true,
      message: `Progresso resetado. ${result.changes} licitações podem ser recapturadas.`
    });
  } catch (error) {
    console.error('[Progresso] Erro ao resetar:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Reset de progresso de uma licitação específica
app.delete('/api/chat/progresso/:compraId', (req, res) => {
  try {
    const { compraId } = req.params;
    const result = db.prepare(`DELETE FROM chat_captura_progresso WHERE compraId = ?`).run(compraId);

    if (result.changes > 0) {
      console.log(`[Progresso] Reset: ${compraId}`);
      res.json({ success: true, message: `Progresso da licitação ${compraId} resetado.` });
    } else {
      res.json({ success: false, message: 'Licitação não encontrada no progresso.' });
    }
  } catch (error) {
    console.error('[Progresso] Erro ao resetar:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== ROTAS DO MONITOR DE MENSAGENS ====================

// Status do monitor de mensagens
app.get('/api/chat/monitor-status', (req, res) => {
  try {
    if (monitorMensagens) {
      res.json({ success: true, ...monitorMensagens.getStatus() });
    } else {
      res.json({ success: true, ativo: false, logs: [], ultimaVerificacao: null, totalMensagensNovas: 0 });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Armazena logs de debug da extensão
const extensaoDebugLogs = [];

// Receber logs de debug da extensão Chrome
app.post('/api/chat/debug-logs', (req, res) => {
  try {
    const { logs, url, timestamp } = req.body;

    // Adiciona os logs ao array com timestamp do servidor
    const logEntry = {
      timestamp: new Date().toISOString(),
      url: url,
      logs: logs || []
    };

    extensaoDebugLogs.push(logEntry);

    // Mantém apenas os últimos 100 registros
    while (extensaoDebugLogs.length > 100) {
      extensaoDebugLogs.shift();
    }

    // Mostra no console do servidor
    console.log('\n[Extensão Debug]', timestamp);
    console.log('URL:', url);
    logs.forEach(l => console.log('  ', l));

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Consultar logs de debug da extensão
app.get('/api/chat/debug-logs', (req, res) => {
  res.json({ success: true, logs: extensaoDebugLogs });
});

// Armazena dados de navegação para aprendizado
const navegacaoLogs = [];

// Receber dados de navegação da extensão
app.post('/api/chat/navegacao', (req, res) => {
  try {
    const dados = req.body;
    navegacaoLogs.push(dados);

    // Mantém apenas os últimos 500 registros
    while (navegacaoLogs.length > 500) {
      navegacaoLogs.shift();
    }

    // Mostra no console
    const emoji = dados.tipo === 'navegacao' ? '🌐' : dados.tipo === 'clique' ? '👆' : '📦';
    console.log(`${emoji} [${dados.tipo}] ${dados.url?.substring(0, 60) || ''}`);
    if (dados.texto) console.log(`   Texto: ${dados.texto}`);
    if (dados.href) console.log(`   Href: ${dados.href}`);

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Consultar dados de navegação
app.get('/api/chat/navegacao', (req, res) => {
  res.json({ success: true, logs: navegacaoLogs });
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

// Função auxiliar para criar assinatura PKCS#7 detached
function createPkcs7Signature(pdfBytes, privateKey, certificate, additionalCerts = []) {
  const p7 = forge.pkcs7.createSignedData();

  // Adicionar certificado do signatário e cadeia
  p7.addCertificate(certificate);
  additionalCerts.forEach(cert => p7.addCertificate(cert));

  // Configurar signer
  p7.addSigner({
    key: privateKey,
    certificate: certificate,
    digestAlgorithm: forge.pki.oids.sha256,
    authenticatedAttributes: [
      {
        type: forge.pki.oids.contentType,
        value: forge.pki.oids.data
      },
      {
        type: forge.pki.oids.messageDigest
        // valor será calculado automaticamente
      },
      {
        type: forge.pki.oids.signingTime,
        value: new Date()
      }
    ]
  });

  // Definir conteúdo a ser assinado (detached = não incluído no PKCS#7)
  p7.content = forge.util.createBuffer(pdfBytes);

  // Assinar
  p7.sign({ detached: true });

  // Converter para DER
  const asn1 = p7.toAsn1();
  const der = forge.asn1.toDer(asn1).getBytes();

  return Buffer.from(der, 'binary');
}

// Função para adicionar placeholder de assinatura manualmente ao PDF
function addSignaturePlaceholder(pdfBuffer, signatureLength = 16384) {
  let pdf = pdfBuffer.toString('binary');

  // Encontrar o final do PDF (%%EOF)
  const eofMatch = pdf.match(/%%EOF[\r\n]?$/);
  if (!eofMatch) {
    throw new Error('PDF inválido: %%EOF não encontrado');
  }

  // Encontrar xref
  const startxrefMatch = pdf.match(/startxref[\r\n]+(\d+)[\r\n]+%%EOF/);
  if (!startxrefMatch) {
    throw new Error('PDF inválido: startxref não encontrado');
  }

  const xrefOffset = parseInt(startxrefMatch[1]);

  // Encontrar trailer
  const trailerMatch = pdf.match(/trailer[\s\S]*?\/Root\s+(\d+)\s+\d+\s+R[\s\S]*?\/Size\s+(\d+)/);
  if (!trailerMatch) {
    throw new Error('PDF inválido: trailer não encontrado');
  }

  const rootRef = trailerMatch[1];
  const objectCount = parseInt(trailerMatch[2]);

  // Criar novos objetos para a assinatura
  const sigObjNum = objectCount;
  const sigFieldObjNum = objectCount + 1;

  const now = new Date();
  const dateStr = `D:${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}-03'00'`;

  // ByteRange placeholder (será preenchido depois)
  const byteRangePlaceholder = '/ByteRange [0 ********** ********** **********]';
  const contentPlaceholder = '<' + '0'.repeat(signatureLength * 2) + '>';

  // Criar objeto de assinatura
  const sigObj = `${sigObjNum} 0 obj\n<<\n/Type /Sig\n/Filter /Adobe.PPKLite\n/SubFilter /adbe.pkcs7.detached\n/M (${dateStr})\n/Name (Assinatura Digital)\n/Reason (Proposta Comercial)\n/Location (Brasil)\n${byteRangePlaceholder}\n/Contents ${contentPlaceholder}\n>>\nendobj\n`;

  // Adicionar objeto de assinatura após o último objeto existente
  const lastEndobj = pdf.lastIndexOf('endobj', xrefOffset);
  const insertPosition = lastEndobj + 6;

  // Inserir objeto de assinatura
  const beforeSig = pdf.substring(0, insertPosition) + '\n';
  const afterSig = pdf.substring(insertPosition);

  const sigObjOffset = beforeSig.length;
  pdf = beforeSig + sigObj + afterSig;

  // Atualizar xref e trailer
  const newXrefOffset = pdf.length;
  const newXref = `xref\n${sigObjNum} 1\n${String(sigObjOffset).padStart(10, '0')} 00000 n \ntrailer\n<<\n/Size ${objectCount + 1}\n/Root ${rootRef} 0 R\n/Prev ${xrefOffset}\n>>\nstartxref\n${newXrefOffset}\n%%EOF\n`;

  pdf = pdf.replace(/%%EOF[\r\n]?$/, newXref);

  return {
    pdf: Buffer.from(pdf, 'binary'),
    signatureOffset: pdf.indexOf(contentPlaceholder) + 1,
    signatureLength: signatureLength * 2,
    byteRangeOffset: pdf.indexOf(byteRangePlaceholder)
  };
}

// Assinar PDF com certificado digital A1
app.post('/api/pdf/assinar', async (req, res) => {
  try {
    const { pdfBase64 } = req.body;

    if (!pdfBase64) {
      return res.status(400).json({ success: false, error: 'PDF não fornecido' });
    }

    // Buscar certificado
    const cert = db.prepare('SELECT certificadoBase64, senhaCriptografada, titular, validade FROM certificado_digital WHERE id = 1').get();

    if (!cert) {
      return res.status(400).json({ success: false, error: 'Certificado não configurado. Configure em Dados do Fornecedor.' });
    }

    const p12Buffer = Buffer.from(cert.certificadoBase64, 'base64');
    const senha = Buffer.from(cert.senhaCriptografada, 'base64').toString();

    // Extrair certificado e chave privada do P12
    const p12Asn1 = forge.asn1.fromDer(p12Buffer.toString('binary'));
    const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, senha);

    // Pegar chave privada
    const keyBags = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag });
    const keyBag = keyBags[forge.pki.oids.pkcs8ShroudedKeyBag][0];
    const privateKey = keyBag.key;

    // Pegar certificado
    const certBags = p12.getBags({ bagType: forge.pki.oids.certBag });
    const certBag = certBags[forge.pki.oids.certBag][0];
    const certificate = certBag.cert;

    // Converter PDF de base64 para buffer
    const pdfBuffer = Buffer.from(pdfBase64, 'base64');

    // Usar pdf-lib para adicionar indicação visual e normalizar
    const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
    const pdfDoc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
    const pages = pdfDoc.getPages();
    const lastPage = pages[pages.length - 1];

    // Adicionar indicação visual de assinatura na última página
    const helveticaFont = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const { width, height } = lastPage.getSize();

    // Caixa de assinatura visual
    const boxX = 50;
    const boxY = 15;
    const boxWidth = width - 100;
    const boxHeight = 45;

    // Desenhar borda da caixa de assinatura
    lastPage.drawRectangle({
      x: boxX,
      y: boxY,
      width: boxWidth,
      height: boxHeight,
      borderColor: rgb(0.2, 0.4, 0.6),
      borderWidth: 1,
      color: rgb(0.95, 0.97, 1)
    });

    // Texto da assinatura
    lastPage.drawText('DOCUMENTO ASSINADO DIGITALMENTE', {
      x: boxX + 10,
      y: boxY + 32,
      size: 9,
      font: helveticaFont,
      color: rgb(0.1, 0.3, 0.5)
    });
    lastPage.drawText(`Signatario: ${cert.titular}`, {
      x: boxX + 10,
      y: boxY + 20,
      size: 8,
      font: helveticaFont,
      color: rgb(0.3, 0.3, 0.3)
    });
    lastPage.drawText(`Data/Hora: ${new Date().toLocaleString('pt-BR')} | Certificado valido ate: ${cert.validade}`, {
      x: boxX + 10,
      y: boxY + 8,
      size: 7,
      font: helveticaFont,
      color: rgb(0.4, 0.4, 0.4)
    });

    // Salvar PDF com indicação visual (sem object streams para compatibilidade)
    const normalizedPdfBytes = await pdfDoc.save({ useObjectStreams: false });

    // Tentar usar @signpdf para assinatura criptográfica
    try {
      // Tentar adicionar placeholder e assinar
      let pdfWithPlaceholder;
      try {
        pdfWithPlaceholder = plainAddPlaceholder({
          pdfBuffer: Buffer.from(normalizedPdfBytes),
          reason: 'Proposta Comercial',
          contactInfo: cert.titular,
          name: cert.titular,
          location: 'Brasil',
          signatureLength: 16384
        });
      } catch (placeholderError) {
        console.error('Erro ao adicionar placeholder:', placeholderError.message);
        // Tentar método alternativo
        throw new Error('Placeholder failed: ' + placeholderError.message);
      }

      // Criar signer P12
      const signer = new P12Signer(p12Buffer, { passphrase: senha });

      // Assinar o PDF
      const signPdf = new SignPdf();
      const signedPdfBuffer = await signPdf.sign(pdfWithPlaceholder, signer);

      console.log('PDF assinado com sucesso usando @signpdf');

      // Retornar PDF assinado
      const signedBase64 = Buffer.from(signedPdfBuffer).toString('base64');
      res.json({ success: true, pdfAssinado: signedBase64 });

    } catch (signError) {
      console.error('Erro com @signpdf:', signError.message);

      // Fallback: retornar PDF com indicação visual apenas
      // A assinatura criptográfica embutida em PDFs requer estrutura específica
      // que pode não ser compatível com todos os geradores de PDF
      console.log('Retornando PDF com indicação visual de assinatura');

      const signedBase64 = Buffer.from(normalizedPdfBytes).toString('base64');
      res.json({
        success: true,
        pdfAssinado: signedBase64,
        metodo: 'visual'
      });
    }

  } catch (error) {
    console.error('Erro ao assinar PDF:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// PROPOSTAS (v1 /api/proposta/enviar + v2 via participações)
// Extraído em NFSE-M06 onda 6.2 para propostas-participacoes-routes.js.
// Factory registrado no topo junto a registrarRotasBi / registrarRotasTEF.


// GRUPOS DE PALAVRAS-CHAVE (pesquisa/exclusão) + rota /pesquisar
// Extraído em NFSE-M06 onda 6.3 para grupos-palavras-routes.js.
// Factory registrado no topo junto a registrarRotasPropostasParticipacoes.


// ==================== JORNAL DE LICITAÇÕES — extraído ====================
// NFSE-M06 onda 6.6 (2026-04-20): 5 rotas migradas para jornal-routes.js.
// agendarJornal() continua chamado pelo master via _iniciarSchedulersMaster.


// Rota de debug para verificar estrutura da tabela
app.get('/api/debug/tabela/:nome', (req, res) => {
  try {
    const info = db.pragma(`table_info(${req.params.nome})`);
    res.json({ success: true, columns: info });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// SISTEMA DE BACKUP E VERSIONAMENTO (backup SQLite + git tags)
// Extraído em NFSE-M06 onda 6.4 para backup-routes.js.
// Factory registrado no topo junto a registrarRotasGruposPalavras.

// ==================== DOWNLOAD DE EXTENSÕES ====================

const { spawn } = require('child_process');
const os = require('os');

// ==================== CONFIG URL DO SERVIDOR ====================

// Retorna a URL do servidor configurada (com fallback para auto-detecção)
app.get('/api/config/server-url', (req, res) => {
  try {
    const urlConfigurada = getConfigValue('server_url');
    const urlDetectada = req.protocol + '://' + req.get('host');
    res.json({
      success: true,
      url: urlConfigurada || urlDetectada,
      configurada: !!urlConfigurada,
      detectada: urlDetectada
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Salva a URL do servidor
app.post('/api/config/server-url', (req, res) => {
  try {
    let { url } = req.body;
    if (!url || typeof url !== 'string') {
      return res.status(400).json({ success: false, error: 'URL é obrigatória' });
    }
    // Remove trailing slash
    url = url.replace(/\/+$/, '');
    setConfigValue('server_url', url);
    res.json({ success: true, url });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== FIM CONFIG URL DO SERVIDOR ====================

// ==================== ANÁLISE IA (rotas) — extraído ====================
// NFSE-M06 onda 6.5 (2026-04-20): 7 rotas migradas para analise-ia-routes.js.
// Factory registrarRotasAnaliseIa chamada no topo junto aos outros módulos.

// Mapa das extensões disponíveis
const extensoesDisponiveis = {
  'token-relay': {
    dir: 'extensions/token-relay',
    nome: 'Licite Agora Token Relay',
    descricao: 'Captura tokens e sincroniza dados do Comprasnet automaticamente'
  }
};

// Listar extensões disponíveis
app.get('/api/extensoes', (req, res) => {
  try {
    const lista = Object.entries(extensoesDisponiveis).map(([slug, ext]) => {
      const manifestPath = path.join(__dirname, ext.dir, 'manifest.json');
      let versao = '-';
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
        versao = manifest.version || '-';
      } catch (e) {}
      return { slug, nome: ext.nome, descricao: ext.descricao, versao };
    });
    res.json({ success: true, extensoes: lista });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Download de extensão como ZIP
// Copia diretório recursivamente
function copiarDiretorioSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copiarDiretorioSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// Remove diretório recursivamente
function removerDiretorioSync(dir) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Substitui placeholders nos arquivos da extensão
function substituirPlaceholders(dir, serverUrl) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const filePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      substituirPlaceholders(filePath, serverUrl);
    } else if (/\.(js|json|html)$/.test(entry.name)) {
      let conteudo = fs.readFileSync(filePath, 'utf-8');
      if (conteudo.includes('__SERVER_URL__')) {
        conteudo = conteudo.replace(/__SERVER_URL__/g, serverUrl);
        fs.writeFileSync(filePath, conteudo, 'utf-8');
      }
    }
  }
}

app.get('/api/extensoes/:slug/download', (req, res) => {
  const ext = extensoesDisponiveis[req.params.slug];
  if (!ext) {
    return res.status(404).json({ success: false, error: 'Extensão não encontrada' });
  }

  const extDir = path.join(__dirname, ext.dir);
  if (!fs.existsSync(extDir)) {
    return res.status(404).json({ success: false, error: 'Diretório da extensão não encontrado' });
  }

  // Obter URL do servidor configurada (fallback para auto-detecção)
  const serverUrl = getConfigValue('server_url') || (req.protocol + '://' + req.get('host'));

  // Copiar para diretório temporário e substituir placeholders
  const tmpDir = path.join(os.tmpdir(), `extensao-${Date.now()}-${ext.dir}`);
  const zipFileName = `${ext.dir}.zip`;
  const tmpZipPath = path.join(os.tmpdir(), `extensao-${Date.now()}-${zipFileName}`);

  try {
    copiarDiretorioSync(extDir, tmpDir);
    substituirPlaceholders(tmpDir, serverUrl);
  } catch (err) {
    console.error('Erro ao preparar extensão:', err);
    removerDiretorioSync(tmpDir);
    return res.status(500).json({ success: false, error: 'Erro ao preparar extensão para download' });
  }

  // Gerar zip em arquivo temporário para garantir Content-Length correto
  const zipProcess = spawn('zip', ['-r', tmpZipPath, '.'], {
    cwd: tmpDir,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  zipProcess.on('close', (code) => {
    // Limpar diretório temporário
    removerDiretorioSync(tmpDir);

    if (code !== 0) {
      try { fs.unlinkSync(tmpZipPath); } catch (e) {}
      return res.status(500).json({ success: false, error: 'Erro ao gerar arquivo zip' });
    }

    res.download(tmpZipPath, zipFileName, (err) => {
      // Limpar arquivo zip temporário após envio
      try { fs.unlinkSync(tmpZipPath); } catch (e) {}
      if (err && !res.headersSent) {
        res.status(500).json({ success: false, error: 'Erro ao enviar arquivo' });
      }
    });
  });

  zipProcess.on('error', (err) => {
    console.error('Erro ao gerar zip:', err);
    removerDiretorioSync(tmpDir);
    try { fs.unlinkSync(tmpZipPath); } catch (e) {}
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: 'Erro ao gerar arquivo zip' });
    }
  });
});

// ==================== FIM DOWNLOAD DE EXTENSÕES ====================

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
