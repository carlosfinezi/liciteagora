/**
 * db-schema.js
 * ------------------------------------------------------------------
 * Extraído do server.js (NFSE-M06 onda 6.33).
 *
 * Contém o schema SQL completo do LiciteAgora + as migrações ad-hoc
 * que evoluíram a base ao longo do tempo. Chamado uma única vez
 * durante o bootstrap do worker (logo após `new Database(dbPath)`)
 * através de initSchema(db).
 *
 * Escopo:
 *   - Todas as `CREATE TABLE IF NOT EXISTS` (~35 tabelas):
 *     licitacoes, itens, config, resultados_bi, interesse,
 *     interesse_compra_id, kanban_status, licitacao_lida, sem_interesse,
 *     config_lances, robo_sessoes, fornecedor, certificado_digital,
 *     valores_proposta, telegram_config, alertas_enviados,
 *     chat_monitoramento, chat_ultima_verificacao, chat_palavras_chave,
 *     licitacoes_monitorar (deprecada), participacoes_comprasnet,
 *     chat_mensagens, chat_captura_progresso, monitoramento_sessao,
 *     grupos_palavras, grupos_palavras_itens, grupos_pesquisa_exclusao,
 *     jornal_config, jornal_grupos, jornal_historico, sniper_itens,
 *     sniper_historico, sniper_classificacao, blitz_agendadas,
 *     licitacao_analise (declarada 2x — idempotente graças ao
 *     IF NOT EXISTS, preservado 1:1).
 *
 *   - Todos os `CREATE INDEX IF NOT EXISTS` correspondentes.
 *
 *   - Seed idempotente `INSERT OR IGNORE INTO jornal_config` (id=1).
 *
 *   - 4 migrações ad-hoc com detecção via PRAGMA table_info():
 *       (1) grupos_palavras.tipo (com bloco aninhado histórico de
 *           chat_mensagens.lido — preservado byte-a-byte, mesmo
 *           sabendo que o aninhamento torna a migração `lido`
 *           condicional ao ramo else da checagem `tipo`).
 *       (2) chat_mensagens — colunas de sync v1 (10 colunas novas)
 *           + índice único parcial idx_chat_mensagens_comprasnet_id.
 *       (3) sniper_itens — 5 colunas de config de lance automático.
 *
 * Idempotência: todo o módulo pode ser chamado N vezes sem efeito
 * colateral (CREATE ... IF NOT EXISTS, INSERT OR IGNORE, e
 * PRAGMA antes de cada ALTER).
 */

function initSchema(db) {
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

}

module.exports = { initSchema };
