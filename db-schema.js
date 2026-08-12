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
// Fase 8 (2026-04-22): tabelas de catálogo (licitacoes, itens,
// resultados_bi, licitacao_analise, orgaos_lookup) migraram para
// data/catalog.db — compartilhadas entre todos os tenants. Schema
// e índices vivem em catalog-manager.js. Aqui ficam só as tabelas
// privadas do tenant + a config key-value local.
db.exec(`
  CREATE TABLE IF NOT EXISTS config (
    chave TEXT PRIMARY KEY,
    valor TEXT,
    dataAtualizacao TEXT DEFAULT CURRENT_TIMESTAMP
  );

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

  -- Análises IA de licitações — privadas por tenant (2026-04-23).
  -- Antes viviam em catalog.licitacao_analise (compartilhadas entre tenants).
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
    produto_compativel INTEGER DEFAULT NULL,
    motivo_compativel TEXT,
    dataAnalise TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_analise_pncp ON licitacao_analise(numeroControlePNCP);
  CREATE INDEX IF NOT EXISTS idx_analise_score ON licitacao_analise(viabilidade_score);

  -- Cache da análise IA de preços (/api/bi/analise-precos).
  -- Hash do filtro (grupoId/q/uf/etc) → JSON da resposta DeepSeek.
  -- TTL próxima meia-noite; primeira chamada paga 40-60s, demais <100ms.
  CREATE TABLE IF NOT EXISTS bi_analise_cache (
    queryHash TEXT PRIMARY KEY,
    queryParams TEXT,
    resposta TEXT NOT NULL,
    dataCache TEXT DEFAULT CURRENT_TIMESTAMP,
    expiresAt TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_bi_analise_cache_expires ON bi_analise_cache(expiresAt);

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
  -- Multi-tenant (2026-04-22): inclui todas as colunas que antes eram
  -- adicionadas via ALTER no boot de monitor-v2.js e nas migrações
  -- ad-hoc abaixo. Para novos tenants, a tabela já nasce completa.
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
    dataCaptura TEXT DEFAULT CURRENT_TIMESTAMP,
    -- de monitor-v2 _executarMigracoes
    categoria TEXT,
    tipoRemetente TEXT,
    identificadorItem TEXT,
    identificadorDestinatario TEXT,
    identificadorRemetente TEXT,
    compraId TEXT,
    lido INTEGER DEFAULT 0,
    dataLeitura TEXT,
    -- de migrações ad-hoc de sync v1 global
    mensagemIdComprasnet INTEGER,
    titulo TEXT,
    origemMensagem TEXT,
    lidaComprasnet INTEGER DEFAULT 0,
    tipoCompra TEXT,
    excluida INTEGER DEFAULT 0,
    vinculadaADiligencia INTEGER DEFAULT 0,
    descricaoModalidade TEXT,
    numeroCompraFormatado TEXT,
    origemCaptura TEXT DEFAULT 'servidor'
  );

  CREATE INDEX IF NOT EXISTS idx_chat_mensagens_licitacao ON chat_mensagens(cnpjOrgao, ano, sequencial);
  CREATE INDEX IF NOT EXISTS idx_chat_mensagens_hash ON chat_mensagens(hashMensagem);
  CREATE INDEX IF NOT EXISTS idx_chat_mensagens_data ON chat_mensagens(dataHoraMensagem DESC);
  CREATE INDEX IF NOT EXISTS idx_chat_mensagens_compra ON chat_mensagens(compraId);

  -- Pregões silenciados pelo usuário: suprime o alerta Telegram desses
  -- compraIds (a captura de mensagens continua normal). Flag controlado
  -- só pelo usuário — não é tocado pelo sync de participações, diferente
  -- de participacoes_comprasnet.ativo (que volta a 1 a cada sync).
  CREATE TABLE IF NOT EXISTS chat_pregoes_silenciados (
    compraId TEXT PRIMARY KEY,
    dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP
  );

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

  -- Agendamento diário de análise IA por grupo de palavras (NFSE-M07).
  -- Cron diário (6h) varre cada grupo ativo, casa licitações abertas que
  -- bate com palavras+exclusão+filtros do grupo, e analisa até limite_diario
  -- delas ignorando as já analisadas. ufs/modalidades são JSON arrays.
  CREATE TABLE IF NOT EXISTS analise_ia_agendamento (
    grupoId INTEGER PRIMARY KEY,
    ativo INTEGER DEFAULT 0,
    ufs TEXT,
    modalidades TEXT,
    valor_minimo REAL,
    limite_diario INTEGER DEFAULT 100,
    produtos_que_vendo TEXT,
    auto_interesse_ativo INTEGER DEFAULT 0,
    auto_telegram_ativo INTEGER DEFAULT 0,
    auto_score_min INTEGER DEFAULT 70,
    ultimo_scan_em TEXT,
    ultimo_scan_total INTEGER DEFAULT 0,
    ultimo_scan_analisadas INTEGER DEFAULT 0,
    ultimo_scan_erros INTEGER DEFAULT 0,
    ultimo_scan_status TEXT,
    ultimo_scan_mensagem TEXT,
    dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
    dataAtualizacao TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (grupoId) REFERENCES grupos_palavras(id) ON DELETE CASCADE
  );

  -- Licitações cuja análise IA falhou, com backoff crescente.
  -- Existe porque a fila do scan só exclui o que está em licitacao_analise, e
  -- essa tabela só recebe linha em caso de SUCESSO: sem isto, uma licitação que
  -- falha volta à fila nas duas janelas de todo dia até encerrar. Medido em
  -- 2026-08-12: 285 das 432 falhas do dia (66%) eram reincidentes de dias
  -- anteriores, cada retentativa reenviando até 40k caracteres ao provider pago.
  -- proximaTentativaEm é o portão: a fila ignora quem ainda não venceu.
  CREATE TABLE IF NOT EXISTS analise_ia_falha (
    cnpj TEXT NOT NULL,
    ano INTEGER NOT NULL,
    sequencial INTEGER NOT NULL,
    tentativas INTEGER NOT NULL DEFAULT 1,
    ultimaFalhaEm TEXT DEFAULT CURRENT_TIMESTAMP,
    proximaTentativaEm TEXT,
    ultimoErro TEXT,
    PRIMARY KEY (cnpj, ano, sequencial)
  );
  CREATE INDEX IF NOT EXISTS idx_analise_falha_proxima ON analise_ia_falha(proximaTentativaEm);

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

  -- Fase 8: licitacao_analise migrou para catalog.db (compartilhado).

  -- Inserir configuração padrão do jornal
  INSERT OR IGNORE INTO jornal_config (id, ativo, horario) VALUES (1, 0, '08:00');
`);

// Multi-tenant (2026-04-22): schemas que antes viviam em migrarDB()
// dentro de cada *-routes.js foram consolidados aqui para rodar de
// uma vez no provisionamento de tenant. São idempotentes (IF NOT EXISTS).
db.exec(`
  -- portal-routes.js: credenciais de clientes do portal público
  CREATE TABLE IF NOT EXISTS cliente_logins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pessoaId INTEGER NOT NULL UNIQUE,
    email TEXT NOT NULL UNIQUE,
    passwordHash TEXT NOT NULL,
    ativo INTEGER NOT NULL DEFAULT 1,
    ultimoLogin TEXT,
    dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (pessoaId) REFERENCES pessoas(id)
  );

  -- contas-receber-routes.js
  CREATE TABLE IF NOT EXISTS categorias_cr (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL UNIQUE,
    icone TEXT,
    ativo INTEGER DEFAULT 1,
    dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS contas_receber_pagamentos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contaReceberId INTEGER NOT NULL,
    dataPagamento TEXT NOT NULL,
    valorPago REAL NOT NULL,
    valorBase REAL NOT NULL,
    juros REAL DEFAULT 0,
    multa REAL DEFAULT 0,
    desconto REAL DEFAULT 0,
    formaPagamento TEXT,
    contaFinanceiraId INTEGER,
    movimentacaoFinanceiraId INTEGER,
    observacoes TEXT,
    estornado INTEGER DEFAULT 0,
    estornadoEm TEXT,
    origem TEXT,
    usuario TEXT,
    dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (contaReceberId) REFERENCES contas_a_receber(id),
    FOREIGN KEY (contaFinanceiraId) REFERENCES contas_financeiras(id)
  );
  CREATE INDEX IF NOT EXISTS idx_crp_conta ON contas_receber_pagamentos(contaReceberId);

  CREATE TABLE IF NOT EXISTS contas_receber_anexos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contaReceberId INTEGER NOT NULL,
    nomeOriginal TEXT NOT NULL,
    caminho TEXT NOT NULL,
    mimeType TEXT,
    tamanho INTEGER,
    tipo TEXT,
    dataUpload TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (contaReceberId) REFERENCES contas_a_receber(id)
  );
  CREATE INDEX IF NOT EXISTS idx_cra_conta ON contas_receber_anexos(contaReceberId);
`);

// ALTERs idempotentes em contas_a_receber (só adicionam coluna se faltar).
// Também tolera "no such table" para o caso de tenant NOVO onde a tabela
// base só é criada depois por financeiro-routes via applyRouteMigrations.
// Nesse fluxo os ALTERs abaixo serão re-tentados (idempotentes) assim que
// a tabela existir — financeiro-routes.migrarDB faz os mesmos ALTERs.
function alterSafe(dbRef, sql) {
  try { dbRef.exec(sql); }
  catch (e) {
    if (/duplicate column/i.test(e.message)) return;
    if (/no such table/i.test(e.message)) return;
    throw e;
  }
}
// fornecedor.regimeTributario: 'NAO_OPTANTE' | 'SIMPLES_NACIONAL' | 'MEI'
// Define opSimpNac/regApTribSN/incluirIM ao construir a DPS NFSe.
alterSafe(db, 'ALTER TABLE fornecedor ADD COLUMN regimeTributario TEXT');
// fornecedor.contribuinteIPI: 1 quando o tenant é indústria contribuinte do IPI
// (IPI vira recuperável e sai do custo de aquisição). Default 0 = revenda.
alterSafe(db, 'ALTER TABLE fornecedor ADD COLUMN contribuinteIPI INTEGER DEFAULT 0');
// fornecedor.regimeApuracaoPISCOFINS: 'cumulativo' | 'nao_cumulativo' | NULL
// nao_cumulativo (típico Lucro Real) → PIS/COFINS recuperáveis saem do custo.
// cumulativo (típico Lucro Presumido) ou NULL → ficam no custo.
alterSafe(db, 'ALTER TABLE fornecedor ADD COLUMN regimeApuracaoPISCOFINS TEXT');

// ==================== MULTI-LOJA / ESTABELECIMENTOS ====================
// Dimensão de estabelecimento (matriz + filiais) dentro do tenant. Fase 1.
// Espelha a estratégia do multi-depósito: linha âncora (matriz) sempre existe,
// e no futuro os domínios fiscais/financeiros carregarão estabelecimentoId
// nullable (NULL = matriz). Por ora é PURAMENTE ADITIVA: o `fornecedor`
// singleton continua sendo a fonte de verdade da matriz; aqui só espelhamos.
//   tipo_vinculo: 'MATRIZ' | 'FILIAL_MESMA_PJ' | 'PJ_DISTINTA'
//     FILIAL_MESMA_PJ → mesma PJ (compartilha atestado; INSS/FGTS herdam da matriz)
//     PJ_DISTINTA     → PJ separada (nada se compartilha por lei)
//   bloqueado: filial nova nasce bloqueada até contratar o CNPJ (cobrança por estab.).
//              A matriz do backfill nasce liberada (já é o tenant contratado).
db.exec(`
  CREATE TABLE IF NOT EXISTS estabelecimentos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    matriz INTEGER DEFAULT 0,
    tipo_vinculo TEXT NOT NULL DEFAULT 'MATRIZ',
    ativo INTEGER DEFAULT 1,
    bloqueado INTEGER DEFAULT 0,
    contratadoEm TEXT,
    razaoSocial TEXT,
    nomeFantasia TEXT,
    cnpj TEXT,
    inscricaoEstadual TEXT,
    inscricaoMunicipal TEXT,
    regimeTributario TEXT,
    contribuinteIPI INTEGER DEFAULT 0,
    regimeApuracaoPISCOFINS TEXT,
    endereco TEXT,
    numero TEXT,
    complemento TEXT,
    bairro TEXT,
    cidade TEXT,
    uf TEXT,
    cep TEXT,
    codigoMunicipio TEXT,
    telefone TEXT,
    celular TEXT,
    email TEXT,
    dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
    dataAtualizacao TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_estab_matriz_unica ON estabelecimentos(matriz) WHERE matriz = 1;
`);
// CSC/CSCid da NFC-e por estabelecimento (Inc 2.3b). A matriz segue usando o
// nfce_config; filiais guardam o próprio CSC aqui (é por-CNPJ, emitido pela SEFAZ).
alterSafe(db, 'ALTER TABLE estabelecimentos ADD COLUMN csc TEXT');
alterSafe(db, 'ALTER TABLE estabelecimentos ADD COLUMN cscId TEXT');
// Backfill idempotente da matriz a partir do fornecedor singleton (só se vazio).
if (!db.prepare('SELECT 1 FROM estabelecimentos LIMIT 1').get()) {
  const forn = db.prepare('SELECT * FROM fornecedor ORDER BY id LIMIT 1').get();
  if (forn) {
    db.prepare(`INSERT INTO estabelecimentos
      (matriz, tipo_vinculo, ativo, bloqueado, contratadoEm,
       razaoSocial, nomeFantasia, cnpj, inscricaoEstadual, inscricaoMunicipal,
       regimeTributario, contribuinteIPI, regimeApuracaoPISCOFINS,
       endereco, numero, complemento, bairro, cidade, uf, cep,
       telefone, celular, email)
      VALUES (1, 'MATRIZ', 1, 0, CURRENT_TIMESTAMP,
       @razaoSocial, @nomeFantasia, @cnpj, @inscricaoEstadual, @inscricaoMunicipal,
       @regimeTributario, @contribuinteIPI, @regimeApuracaoPISCOFINS,
       @endereco, @numero, @complemento, @bairro, @cidade, @uf, @cep,
       @telefone, @celular, @email)`).run({
      razaoSocial: forn.razaoSocial ?? null,
      nomeFantasia: forn.nomeFantasia ?? null,
      cnpj: forn.cnpj ?? null,
      inscricaoEstadual: forn.inscricaoEstadual ?? null,
      inscricaoMunicipal: forn.inscricaoMunicipal ?? null,
      regimeTributario: forn.regimeTributario ?? null,
      contribuinteIPI: forn.contribuinteIPI ?? 0,
      regimeApuracaoPISCOFINS: forn.regimeApuracaoPISCOFINS ?? null,
      endereco: forn.endereco ?? null,
      numero: forn.numero ?? null,
      complemento: forn.complemento ?? null,
      bairro: forn.bairro ?? null,
      cidade: forn.cidade ?? null,
      uf: forn.uf ?? null,
      cep: forn.cep ?? null,
      telefone: forn.telefone ?? null,
      celular: forn.celular ?? null,
      email: forn.email ?? null
    });
  } else {
    // Tenant sem fornecedor ainda: cria a matriz âncora em branco.
    db.prepare(`INSERT INTO estabelecimentos (matriz, tipo_vinculo, ativo, bloqueado, contratadoEm)
                VALUES (1, 'MATRIZ', 1, 0, CURRENT_TIMESTAMP)`).run();
  }
}

// Certificado digital por estabelecimento (Fase 1 multi-loja). Coluna nullable:
// o certificado da MATRIZ continua na linha legada id=1 que todo o emitente
// fiscal lê hoje (WHERE id=1) — aqui só marcamos a que estabelecimento pertence.
// Filiais ganham linhas próprias. Índice único garante no máx. 1 cert/estab.
alterSafe(db, 'ALTER TABLE certificado_digital ADD COLUMN estabelecimentoId INTEGER');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_cert_estab ON certificado_digital(estabelecimentoId) WHERE estabelecimentoId IS NOT NULL');
try {
  const _m = db.prepare('SELECT id FROM estabelecimentos WHERE matriz = 1').get();
  if (_m) db.prepare('UPDATE certificado_digital SET estabelecimentoId = ? WHERE id = 1 AND estabelecimentoId IS NULL').run(_m.id);
} catch {}

// Multi-loja Fase 2: estabelecimentoId nos domínios fiscal/financeiro/estoque
// (NULL = matriz). Estes ALTERs também existem nos migrar() dos módulos de
// rota, mas lá só rodam em tenant NOVO (provision) — no boot rodam contra o
// BOOT_STUB do proxy (no-op). Espelho aqui para tenants existentes, mesmo
// padrão de os-routes/habilitacao. alterSafe ignora "no such table" (em DB
// zerado a tabela ainda não existe aqui; o provision cobre esse caso).
alterSafe(db, 'ALTER TABLE faturas ADD COLUMN estabelecimentoId INTEGER');
alterSafe(db, 'ALTER TABLE depositos ADD COLUMN estabelecimentoId INTEGER');
alterSafe(db, 'ALTER TABLE contas_financeiras ADD COLUMN estabelecimentoId INTEGER');
alterSafe(db, 'ALTER TABLE contas_a_receber ADD COLUMN estabelecimentoId INTEGER');
alterSafe(db, 'ALTER TABLE contas_a_pagar ADD COLUMN estabelecimentoId INTEGER');
// Série/numeração NF-e/NFC-e por estabelecimento (espelho de nfe-emit-routes.migrar).
db.exec(`
  CREATE TABLE IF NOT EXISTS estabelecimento_serie (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    estabelecimentoId INTEGER NOT NULL,
    modelo TEXT NOT NULL,
    serie INTEGER NOT NULL DEFAULT 1,
    proximoNumero INTEGER NOT NULL DEFAULT 1,
    dataAtualizacao TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(estabelecimentoId, modelo, serie)
  );
`);

alterSafe(db, 'ALTER TABLE contas_a_receber ADD COLUMN categoriaId INTEGER');
alterSafe(db, 'ALTER TABLE contas_a_receber ADD COLUMN parcelaNumero INTEGER');
alterSafe(db, 'ALTER TABLE contas_a_receber ADD COLUMN totalParcelas INTEGER');
alterSafe(db, 'ALTER TABLE contas_a_receber ADD COLUMN grupoParcelaId TEXT');

// Seed de categorias padrão (idempotente)
const _seedCr = db.prepare('INSERT OR IGNORE INTO categorias_cr (nome, icone) VALUES (?, ?)');
for (const c of [
  { nome: 'Vendas', icone: '🛒' },
  { nome: 'Serviços', icone: '🔧' },
  { nome: 'Licitações', icone: '📋' },
  { nome: 'Assinaturas', icone: '🔁' },
  { nome: 'Aluguel recebido', icone: '🏠' },
  { nome: 'Juros/Rendimentos', icone: '📈' },
  { nome: 'Outros', icone: '📌' }
]) _seedCr.run(c.nome, c.icone);

// pedidos-routes.js
db.exec(`
  CREATE TABLE IF NOT EXISTS pedido_historico (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pedidoId INTEGER NOT NULL,
    statusAnterior TEXT,
    statusNovo TEXT,
    acao TEXT NOT NULL,
    motivo TEXT,
    usuario TEXT,
    dadosExtras TEXT,
    dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (pedidoId) REFERENCES pedidos(id)
  );
  CREATE INDEX IF NOT EXISTS idx_pedido_hist_pedido ON pedido_historico(pedidoId);

  CREATE TABLE IF NOT EXISTS pedido_parcelas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pedidoId INTEGER NOT NULL,
    numeroParcela INTEGER NOT NULL,
    valor REAL NOT NULL,
    dataVencimento TEXT NOT NULL,
    meioPagamento TEXT NOT NULL,
    bandeiraId INTEGER,
    observacao TEXT,
    FOREIGN KEY (pedidoId) REFERENCES pedidos(id),
    FOREIGN KEY (bandeiraId) REFERENCES adquirentes_cartao(id)
  );
  CREATE INDEX IF NOT EXISTS idx_pedparc_pedido ON pedido_parcelas(pedidoId);

  CREATE TABLE IF NOT EXISTS adquirentes_cartao (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL,
    cnpj TEXT,
    taxaPercentual REAL DEFAULT 0,
    prazoLiquidacaoDias INTEGER DEFAULT 0,
    contaFinanceiraPadraoId INTEGER,
    observacoes TEXT,
    ativo INTEGER DEFAULT 1,
    dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
    dataAtualizacao TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (contaFinanceiraPadraoId) REFERENCES contas_financeiras(id)
  );
  CREATE INDEX IF NOT EXISTS idx_adq_ativo ON adquirentes_cartao(ativo);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_adq_nome_unique ON adquirentes_cartao(nome);

  -- Fase 8: orgaos_lookup migrou para catalog.db (compartilhado).

  CREATE TABLE IF NOT EXISTS transportadoras (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cpfCnpj TEXT NOT NULL UNIQUE,
    razaoSocial TEXT NOT NULL,
    nomeFantasia TEXT,
    rntrc TEXT,
    placa TEXT,
    inscricaoEstadual TEXT,
    endereco TEXT, numero TEXT, complemento TEXT, bairro TEXT,
    cidade TEXT, uf TEXT, cep TEXT, codigoMunicipio TEXT,
    telefone TEXT, email TEXT, contato TEXT, observacoes TEXT,
    ativo INTEGER DEFAULT 1,
    dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
    dataAtualizacao TEXT DEFAULT CURRENT_TIMESTAMP
  );
`);

for (const col of [
  'transportadoraId INTEGER',
  'tipoFrete TEXT',
  'valorFrete REAL',
  'dataValidade TEXT',
  'dataFaturamentoPrevista TEXT',
  'codigoPedidoCliente TEXT',
  'meioPagamento TEXT',
  'observacoesInterna TEXT',
  'enderecoEntrega TEXT',
  'numeroEntrega TEXT',
  'complementoEntrega TEXT',
  'bairroEntrega TEXT',
  'cidadeEntrega TEXT',
  'ufEntrega TEXT',
  'cepEntrega TEXT',
  'codigoMunicipioEntrega TEXT',
  'contatoEntrega TEXT',
  'telefoneEntrega TEXT',
  "modoDocumento TEXT NOT NULL DEFAULT 'pedido'",
  'naoEmitirNFe INTEGER NOT NULL DEFAULT 0',
  'tabelaPrecoId INTEGER'
]) alterSafe(db, `ALTER TABLE pedidos ADD COLUMN ${col}`);

alterSafe(db, 'ALTER TABLE contas_a_receber ADD COLUMN adquirenteCartaoId INTEGER');

// Plano 12 (2026-04-23): amarrar CR/CP ao plano de contas + centro de custo.
// centroCustoId já existia ALTER-ado por rotas antigas, mas planoContaId não.
//
// Tabelas plano_contas + centros_custo migradas de gerencial-routes.js (que
// rodava migrarDB(db) contra o BOOT_STUB do proxy multi-tenant — no-op nos
// tenants). Aqui no initSchema rodam contra o DB real do tenant.
db.exec(`
  CREATE TABLE IF NOT EXISTS centros_custo (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    codigo TEXT,
    nome TEXT NOT NULL UNIQUE,
    descricao TEXT,
    ativo INTEGER DEFAULT 1,
    dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS plano_contas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    codigo TEXT NOT NULL UNIQUE,
    nome TEXT NOT NULL,
    tipo TEXT NOT NULL,
    parentId INTEGER,
    nivel INTEGER NOT NULL DEFAULT 1,
    ordem INTEGER DEFAULT 0,
    ativo INTEGER DEFAULT 1,
    FOREIGN KEY (parentId) REFERENCES plano_contas(id)
  );
  CREATE INDEX IF NOT EXISTS idx_plano_parent ON plano_contas(parentId);
  CREATE INDEX IF NOT EXISTS idx_plano_tipo ON plano_contas(tipo, ativo);
`);

// Seed inicial do plano de contas (idempotente — só se vazio)
const _temPlano = db.prepare('SELECT id FROM plano_contas LIMIT 1').get();
if (!_temPlano) {
  const _insPlano = db.prepare('INSERT INTO plano_contas (codigo, nome, tipo, parentId, nivel, ordem) VALUES (?, ?, ?, ?, ?, ?)');
  const _add = (codigo, nome, tipo, parentId, nivel, ordem) => _insPlano.run(codigo, nome, tipo, parentId, nivel, ordem).lastInsertRowid;
  const r1 = _add('1', 'RECEITA OPERACIONAL', 'receita', null, 1, 10);
    _add('1.1', 'Receita de Vendas', 'receita', r1, 2, 11);
    _add('1.2', 'Outras Receitas Operacionais', 'receita', r1, 2, 12);
  const r2 = _add('2', 'DEDUÇÕES DA RECEITA', 'deducao', null, 1, 20);
    _add('2.1', 'Impostos sobre Vendas (Simples)', 'deducao', r2, 2, 21);
    _add('2.2', 'Devoluções e Cancelamentos', 'deducao', r2, 2, 22);
  const r3 = _add('3', 'CUSTO DAS MERCADORIAS/SERVIÇOS', 'custo', null, 1, 30);
    _add('3.1', 'CMV — Custo de Mercadorias', 'custo', r3, 2, 31);
    _add('3.2', 'Custo dos Serviços Prestados', 'custo', r3, 2, 32);
  const r4 = _add('4', 'DESPESAS OPERACIONAIS', 'despesa', null, 1, 40);
    _add('4.1', 'Pessoal (Salários, Encargos)', 'despesa', r4, 2, 41);
    _add('4.2', 'Administrativas (Aluguel, Energia)', 'despesa', r4, 2, 42);
    _add('4.3', 'Comerciais (Marketing, Comissão)', 'despesa', r4, 2, 43);
    _add('4.4', 'Tecnologia', 'despesa', r4, 2, 44);
    _add('4.5', 'Outras Despesas', 'despesa', r4, 2, 45);
  const r5 = _add('5', 'RESULTADO FINANCEIRO', 'financeiro_receita', null, 1, 50);
    _add('5.1', 'Receitas Financeiras (Juros recebidos)', 'financeiro_receita', r5, 2, 51);
    _add('5.2', 'Despesas Financeiras (Juros, taxas)', 'financeiro_despesa', r5, 2, 52);
  const r6 = _add('6', 'INVESTIMENTOS', 'investimento', null, 1, 60);
    _add('6.1', 'Aquisição de Imobilizado', 'investimento', r6, 2, 61);
  const r9 = _add('9', 'TRANSFERÊNCIAS', 'transferencia', null, 1, 90);
    _add('9.1', 'Transferência entre contas', 'transferencia', r9, 2, 91);
}

alterSafe(db, 'ALTER TABLE contas_a_receber ADD COLUMN planoContaId INTEGER');
alterSafe(db, 'ALTER TABLE contas_a_receber ADD COLUMN centroCustoId INTEGER');
alterSafe(db, 'ALTER TABLE contas_a_pagar ADD COLUMN planoContaId INTEGER');
alterSafe(db, 'ALTER TABLE contas_a_pagar ADD COLUMN centroCustoId INTEGER');
alterSafe(db, 'ALTER TABLE categorias_cr ADD COLUMN planoContaId INTEGER');
alterSafe(db, 'ALTER TABLE categorias_cp ADD COLUMN planoContaId INTEGER');

const _seedAdq = db.prepare('INSERT OR IGNORE INTO adquirentes_cartao (nome) VALUES (?)');
for (const nome of ['Cielo', 'Stone', 'Rede', 'PagSeguro', 'Getnet', 'SafraPay', 'Vero']) {
  _seedAdq.run(nome);
}

// produtos-routes.js
db.exec(`
  CREATE TABLE IF NOT EXISTS produtos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sku TEXT NOT NULL UNIQUE,
    descricao TEXT NOT NULL,
    unidade TEXT DEFAULT 'UN',
    precoCusto REAL DEFAULT 0,
    precoVenda REAL DEFAULT 0,
    ncm TEXT,
    cest TEXT,
    cfopPadrao TEXT,
    origem TEXT,
    icmsAliquota REAL,
    estoqueMinimo REAL DEFAULT 0,
    observacoes TEXT,
    licitacaoItemId INTEGER,
    ativo INTEGER DEFAULT 1,
    dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
    dataAtualizacao TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_produtos_descricao ON produtos(descricao);

  CREATE TABLE IF NOT EXISTS movimentacoes_estoque (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    produtoId INTEGER NOT NULL,
    tipo TEXT NOT NULL,
    quantidade REAL NOT NULL,
    custoUnitario REAL,
    origem TEXT,
    origemId INTEGER,
    observacao TEXT,
    data TEXT NOT NULL,
    dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (produtoId) REFERENCES produtos(id)
  );
  CREATE INDEX IF NOT EXISTS idx_movimentacoes_produto ON movimentacoes_estoque(produtoId);
  CREATE INDEX IF NOT EXISTS idx_movimentacoes_origem ON movimentacoes_estoque(origem, origemId);

  CREATE TABLE IF NOT EXISTS produto_codigos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    produtoId INTEGER NOT NULL,
    codigo TEXT NOT NULL,
    tipo TEXT NOT NULL DEFAULT 'outro',
    fornecedorId INTEGER,
    principal INTEGER DEFAULT 0,
    ativo INTEGER DEFAULT 1,
    dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (produtoId) REFERENCES produtos(id),
    UNIQUE (codigo, tipo, fornecedorId)
  );
  CREATE INDEX IF NOT EXISTS idx_produto_codigos_produto ON produto_codigos(produtoId, ativo);
  CREATE INDEX IF NOT EXISTS idx_produto_codigos_codigo ON produto_codigos(codigo);
  -- UNIQUE inline não pega fornecedorId NULL (NULLs são distintos no SQLite) —
  -- índices parciais garantem unicidade real nos dois casos
  CREATE UNIQUE INDEX IF NOT EXISTS idx_produto_codigos_unico_semforn
    ON produto_codigos(codigo, tipo) WHERE fornecedorId IS NULL AND ativo = 1;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_produto_codigos_unico_comforn
    ON produto_codigos(codigo, tipo, fornecedorId) WHERE fornecedorId IS NOT NULL AND ativo = 1;

  CREATE TABLE IF NOT EXISTS produto_kit_itens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    produtoPaiId INTEGER NOT NULL,
    produtoFilhoId INTEGER NOT NULL,
    quantidade REAL NOT NULL,
    FOREIGN KEY (produtoPaiId) REFERENCES produtos(id),
    FOREIGN KEY (produtoFilhoId) REFERENCES produtos(id),
    UNIQUE (produtoPaiId, produtoFilhoId)
  );
  CREATE INDEX IF NOT EXISTS idx_kit_pai ON produto_kit_itens(produtoPaiId);

  CREATE TABLE IF NOT EXISTS servicos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    codigo TEXT UNIQUE,
    nome TEXT NOT NULL UNIQUE,
    descricao TEXT,
    categoria TEXT,
    unidade TEXT DEFAULT 'serviço',
    valorPadrao REAL,
    cNBS TEXT,
    xNBS TEXT,
    codigoTributacaoNacional TEXT,
    codigoListaServico TEXT,
    ativo INTEGER DEFAULT 1,
    dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
    dataAtualizacao TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_servicos_ativo ON servicos(ativo);
  CREATE INDEX IF NOT EXISTS idx_servicos_categoria ON servicos(categoria);

  CREATE TABLE IF NOT EXISTS pedidos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    numero TEXT NOT NULL UNIQUE,
    tipo TEXT NOT NULL DEFAULT 'manual',
    clienteId INTEGER,
    participacaoId INTEGER,
    compraId TEXT,
    status TEXT NOT NULL DEFAULT 'rascunho',
    dataPedido TEXT NOT NULL,
    dataEntregaPrevista TEXT,
    dataEntregaReal TEXT,
    valorTotal REAL DEFAULT 0,
    valorPago REAL DEFAULT 0,
    statusPagamento TEXT DEFAULT 'pendente',
    observacao TEXT,
    dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
    dataAtualizacao TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (clienteId) REFERENCES pessoas(id),
    FOREIGN KEY (participacaoId) REFERENCES participacoes_comprasnet(id)
  );
  CREATE INDEX IF NOT EXISTS idx_pedidos_status ON pedidos(status);
  CREATE INDEX IF NOT EXISTS idx_pedidos_cliente ON pedidos(clienteId);
  CREATE INDEX IF NOT EXISTS idx_pedidos_participacao ON pedidos(participacaoId);

  CREATE TABLE IF NOT EXISTS pedido_itens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pedidoId INTEGER NOT NULL,
    produtoId INTEGER,
    descricao TEXT NOT NULL,
    quantidade REAL NOT NULL,
    precoUnitario REAL NOT NULL,
    valorTotal REAL NOT NULL,
    FOREIGN KEY (pedidoId) REFERENCES pedidos(id),
    FOREIGN KEY (produtoId) REFERENCES produtos(id)
  );
  CREATE INDEX IF NOT EXISTS idx_pedido_itens_pedido ON pedido_itens(pedidoId);

  CREATE TABLE IF NOT EXISTS produto_lookup (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tipo TEXT NOT NULL,
    valor TEXT NOT NULL,
    ativo INTEGER DEFAULT 1,
    dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(tipo, valor)
  );
  CREATE INDEX IF NOT EXISTS idx_lookup_tipo ON produto_lookup(tipo, ativo);

  CREATE TABLE IF NOT EXISTS fornecedores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cpfCnpj TEXT NOT NULL UNIQUE,
    tipo TEXT NOT NULL DEFAULT 'PJ',
    razaoSocial TEXT NOT NULL,
    nomeFantasia TEXT,
    inscricaoEstadual TEXT,
    inscricaoMunicipal TEXT,
    endereco TEXT, numero TEXT, complemento TEXT, bairro TEXT,
    codigoMunicipio TEXT, cidade TEXT, uf TEXT, cep TEXT,
    telefone TEXT, email TEXT, contato TEXT, observacoes TEXT,
    ativo INTEGER DEFAULT 1,
    dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
    dataAtualizacao TEXT DEFAULT CURRENT_TIMESTAMP
  );
`);

// ALTERs idempotentes para produtos (iteração 2 + fases)
for (const col of [
  'categoria TEXT', 'marca TEXT', 'modelo TEXT', 'cor TEXT',
  'material TEXT', 'genero TEXT',
  'codigoInterno TEXT', 'referenciaInterna TEXT', 'codigoBarras TEXT',
  'fornecedorId INTEGER', 'markupMinimo REAL', 'precoMinimoVenda REAL', 'markupVenda REAL',
  'imagemPath TEXT', 'codigoFCI TEXT', 'validadeDias INTEGER', 'escalaRelevante INTEGER DEFAULT 0',
  'tipoProduto TEXT', 'pesoBruto REAL', 'pesoLiquido REAL',
  'codigoCatmat TEXT', 'codigoCatser TEXT', 'codigoPDM TEXT',
  'cstIBS TEXT', 'cstCBS TEXT', 'cClassTrib TEXT',
  'altura REAL', 'largura REAL', 'profundidade REAL'
]) alterSafe(db, `ALTER TABLE produtos ADD COLUMN ${col}`);

// sniper-lance-routes.js + monitor-v2.js: ALTERs em participacoes_comprasnet
for (const col of [
  'modoDisputa TEXT',
  'dataHoraInicioDisputa TEXT',
  'dataHoraFimDisputa TEXT',
  'linkPncp TEXT',
  'exclusivaMeEpp INTEGER DEFAULT 0',
  'modalidade INTEGER',
  'criterioJulgamento TEXT',
  'fundamentoLegal TEXT',
  'faseCompra TEXT',
  'homologada INTEGER DEFAULT 0',
  'possuiDiligencia INTEGER DEFAULT 0',
  'situacaoAnexos TEXT',
  'chaveCompraPncp TEXT',
  'dadosCompletos TEXT',
  'propostaEnviadaEm TEXT',
]) alterSafe(db, `ALTER TABLE participacoes_comprasnet ADD COLUMN ${col}`);
for (const col of [
  'custo REAL',
  'variacaoMinima REAL',
  "tipoVariacao TEXT DEFAULT 'V'",
  'agressividadePct REAL DEFAULT 20',
]) alterSafe(db, `ALTER TABLE sniper_itens ADD COLUMN ${col}`);

// Fase 1 NFSE-M07 (2026-05-14): produtos_que_vendo per-grupo + classificação
// de compatibilidade na análise IA. Migrations idempotentes pra tenants
// existentes que ainda não têm as colunas.
alterSafe(db, 'ALTER TABLE analise_ia_agendamento ADD COLUMN produtos_que_vendo TEXT');
alterSafe(db, 'ALTER TABLE licitacao_analise ADD COLUMN produto_compativel INTEGER DEFAULT NULL');
alterSafe(db, 'ALTER TABLE licitacao_analise ADD COLUMN motivo_compativel TEXT');

// Fase 2 NFSE-M07: auto-ações (marcar interesse + Telegram) após análise
// classificar como produto_compativel=true com score acima de auto_score_min.
alterSafe(db, 'ALTER TABLE analise_ia_agendamento ADD COLUMN auto_interesse_ativo INTEGER DEFAULT 0');
alterSafe(db, 'ALTER TABLE analise_ia_agendamento ADD COLUMN auto_telegram_ativo INTEGER DEFAULT 0');
alterSafe(db, 'ALTER TABLE analise_ia_agendamento ADD COLUMN auto_score_min INTEGER DEFAULT 70');

// Fase 3 NFSE-M07 (2026-05-18): forma de disputa (por item / por lote / global) —
// PNCP não expõe estruturadamente, IA extrai do edital. Usado pra avisar o
// usuário quando auto-interesse está marcando item em licitação cujo lance
// é por lote (precisa cotar tudo, não só o item de interesse).
alterSafe(db, 'ALTER TABLE licitacao_analise ADD COLUMN forma_disputa_itens TEXT');
alterSafe(db, 'ALTER TABLE licitacao_analise ADD COLUMN justificativa_disputa TEXT');

// 2026-05-19: histórico permanente de blitzes (rajadas). A tabela
// `blitz_agendadas` é só queue ativa — linhas são deletadas quando a blitz
// dispara ou é cancelada. `blitz_historico` retém o registro pra auditoria,
// incluindo status final (executada/cancelada/expirada) e contagem de lances.
db.exec(`
  CREATE TABLE IF NOT EXISTS blitz_historico (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    blitzKey TEXT NOT NULL,
    compraId TEXT NOT NULL,
    itemNumero INTEGER NOT NULL,
    horarioAlvo TEXT NOT NULL,
    alvoMs INTEGER NOT NULL,
    maxLances INTEGER,
    modoBlitz TEXT,
    status TEXT NOT NULL DEFAULT 'agendada',
    agendadoEm TEXT DEFAULT CURRENT_TIMESTAMP,
    executadoEm TEXT,
    canceladoEm TEXT,
    lancesEnviados INTEGER DEFAULT 0,
    observacao TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_blitz_hist_compra ON blitz_historico(compraId, itemNumero);
  CREATE INDEX IF NOT EXISTS idx_blitz_hist_key ON blitz_historico(blitzKey);
  CREATE INDEX IF NOT EXISTS idx_blitz_hist_agendado ON blitz_historico(agendadoEm DESC);

  -- Telemetria fina de cada disparo de blitz (2026-05-25).
  -- Mede timing fim-a-fim para calibrar oneWay/intervaloRR/bufferSpike do auto-cálculo.
  --   alvoMs:             timestamp do alvo configurado (ou auto-calc)
  --   dispatchMs:         quando o timer realmente disparou
  --   desvioInicialMs:    dispatchMs - alvoMs (positivo = atrasou)
  --   fimContagemNoT0:    valor de fimContagem no momento do disparo (snapshot)
  --   rttMedioMs/MaxMs:   RTT entre os lances enviados
  --   ultimoChegadaMs:    estimativa de quando o último lance chegou ao Comprasnet
  --   deltaVsEncerramentoMs: ultimoChegadaMs - fimContagemNoT0 (negativo = chegou antes; > 0 = atrasou)
  CREATE TABLE IF NOT EXISTS blitz_telemetria (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    blitzKey TEXT,
    compraId TEXT NOT NULL,
    itemNumero INTEGER NOT NULL,
    tag TEXT,
    alvoMs INTEGER NOT NULL,
    dispatchMs INTEGER NOT NULL,
    desvioInicialMs INTEGER,
    fimContagemNoT0 TEXT,
    numLances INTEGER DEFAULT 0,
    sucessos INTEGER DEFAULT 0,
    falhas INTEGER DEFAULT 0,
    rttMedioMs INTEGER,
    rttMaxMs INTEGER,
    rttMinMs INTEGER,
    ultimoChegadaMs INTEGER,
    deltaVsEncerramentoMs INTEGER,
    numItensCoalescidos INTEGER DEFAULT 1,
    criadoEm TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_blitz_tel_criado ON blitz_telemetria(criadoEm DESC);
  CREATE INDEX IF NOT EXISTS idx_blitz_tel_item ON blitz_telemetria(compraId, itemNumero);

  -- Health do Comprasnet (2026-05-25). Cada chamada relevante (GUARD poll,
  -- ping ativo, warmup) registra status + latência. Retém só últimos N dias
  -- (cron de purge separado).
  --   tipo: 'guard' | 'ping' | 'warmup' | 'lance' (origem)
  --   endpoint: path chamado (ex: '/comprasnet-disputa/v1/compras/X/itens/em-disputa')
  --   ok: 1 se status 2xx/3xx, 0 caso contrário (timeout/5xx/4xx)
  CREATE TABLE IF NOT EXISTS comprasnet_health (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tipo TEXT NOT NULL,
    endpoint TEXT,
    httpStatus INTEGER,
    tempoMs INTEGER,
    ok INTEGER NOT NULL DEFAULT 0,
    erro TEXT,
    ts TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_cnet_health_ts ON comprasnet_health(ts DESC);
  CREATE INDEX IF NOT EXISTS idx_cnet_health_ok ON comprasnet_health(ok, ts DESC);

  -- Histórico de tokens Bearer recebidos (2026-05-25). Cada setToken aceito
  -- cria uma linha. Permite calcular duração efetiva, gaps sem token, alertar
  -- antes de expirar (via campo expEm decodificado do JWT).
  --   source: 'electron' | 'extension' | 'manual'
  --   jti:    JWT ID (se presente no claim) — pra dedup
  --   tokenFingerprint: SHA1 dos 20 primeiros chars (não armazena token completo)
  --   expEm:  timestamp da expiração real (claim exp do JWT)
  --   substituidoEm: quando outro token tomou o lugar (null = ainda atual)
  CREATE TABLE IF NOT EXISTS bearer_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    tokenFingerprint TEXT NOT NULL,
    jti TEXT,
    subject TEXT,
    recebidoEm TEXT NOT NULL,
    expEm TEXT,
    substituidoEm TEXT,
    duracaoEsperadaSeg INTEGER,
    UNIQUE(tokenFingerprint, recebidoEm)
  );
  CREATE INDEX IF NOT EXISTS idx_bearer_hist_recebido ON bearer_history(recebidoEm DESC);
  CREATE INDEX IF NOT EXISTS idx_bearer_hist_exp ON bearer_history(expEm);

  -- Heartbeat do Electron Standalone (2026-05-27). Cada ciclo de 30s o
  -- serverSync.enviarHeartbeat() registra um snapshot do seu estado interno
  -- — visível pelo Electron, invisível pelo servidor. Permite auditar
  -- "tem Electron rodando?" e "ele está capturando bearer?" de fora.
  --   tokenPresent: 1 se _getBearer() != null, 0 caso contrário
  --   tokenAgeSec: idade em segundos do bearer em memória (NULL se sem token)
  --   lastCaptureAt: timestamp do último Bearer capturado pelo interceptor
  --   ssoMorto: 1 se serverSync marcou sso morto
  --   lastSendAttemptAt: timestamp da última tentativa de POST /api/auth/token
  --   lastSendStatus: HTTP status do último envio (ex: '200', '401', 'timeout', '0')
  --   portal: 'comprasnet' | 'bnc' | ... (qual webview)
  --   versao: versão do Electron Standalone (ex: '5.1.8')
  CREATE TABLE IF NOT EXISTS electron_heartbeat (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    recebidoEm TEXT NOT NULL,
    tokenPresent INTEGER,
    tokenAgeSec INTEGER,
    lastCaptureAt TEXT,
    ssoMorto INTEGER,
    lastSendAttemptAt TEXT,
    lastSendStatus TEXT,
    portal TEXT,
    versao TEXT,
    subject TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_electron_hb_recebido ON electron_heartbeat(recebidoEm DESC);

  -- Eventos do Electron (2026-05-27). /api/sniper/log já recebe pulses
  -- com source=electron — agora persistimos pra timeline na auditoria.
  -- Tipos comuns: 'retoken-http-ok', 'retoken-http-fail', 'idle-dialog',
  -- 'reload-keepalive', 'reload-timeout-sso-morto'. Detalhes (status, error,
  -- action) ficam em JSON pra não criar coluna por evento.
  CREATE TABLE IF NOT EXISTS electron_eventos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    recebidoEm TEXT NOT NULL,
    tipo TEXT NOT NULL,
    msg TEXT,
    detalhes TEXT,
    source TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_electron_ev_recebido ON electron_eventos(recebidoEm DESC);
  CREATE INDEX IF NOT EXISTS idx_electron_ev_tipo ON electron_eventos(tipo, recebidoEm DESC);
`);

// nfse-routes.js
db.exec(`
  CREATE TABLE IF NOT EXISTS nfse (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    idDps TEXT,
    serie TEXT,
    nDPS INTEGER,
    tpAmb INTEGER DEFAULT 2,
    chaveAcesso TEXT,
    nNFSe TEXT,
    tomadorCpfCnpj TEXT,
    tomadorRazaoSocial TEXT,
    tomadorEndereco TEXT,
    codigoTributacaoNacional TEXT,
    descricaoServico TEXT,
    valorServico REAL,
    dataCompetencia TEXT,
    status TEXT DEFAULT 'processando',
    xmlEnvio TEXT,
    xmlRetorno TEXT,
    motivoCancelamento TEXT,
    dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
    dataAtualizacao TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS nfse_config (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);
const _seedNfse = db.prepare('INSERT OR IGNORE INTO nfse_config (key, value) VALUES (?, ?)');
_seedNfse.run('ambiente', '2');
_seedNfse.run('serie', '1');
_seedNfse.run('cod_municipio', '');
_seedNfse.run('proximo_numero', '1');

// NBS — Nomenclatura Brasileira de Serviços (LC 214/2025, NT 004/2025).
// Persistidos para rastreabilidade do que foi enviado em cada DPS.
alterSafe(db, 'ALTER TABLE nfse ADD COLUMN cNBS TEXT');
alterSafe(db, 'ALTER TABLE nfse ADD COLUMN xNBS TEXT');

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


// ============================================================
// Plano 9.1 (2026-04-22) — OS profissional: tipos, checklist,
// anexos, eventos, assinaturas, SLA, orçamento público. Schema
// idempotente; tenants existentes ganham via ALTER TABLE.
// Tabelas legacy (os_ordens, os_itens_pecas, os_itens_servicos,
// os_apontamentos) continuam em os-routes.migrarDB — aqui só
// as novas + ALTERs.
// ============================================================

db.exec(`
  CREATE TABLE IF NOT EXISTS os_tipos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL UNIQUE,
    slug TEXT NOT NULL UNIQUE,
    descricao TEXT,
    modoFiscal TEXT NOT NULL DEFAULT 'sefaz',
    slaDiasPadrao INTEGER,
    exigeEnderecoExec INTEGER DEFAULT 0,
    exigeAssinaturaCliente INTEGER DEFAULT 0,
    exigeOrcamentoAprovado INTEGER DEFAULT 0,
    checklistPadrao TEXT DEFAULT '[]',
    cor TEXT DEFAULT '#4dabf7',
    ativo INTEGER DEFAULT 1,
    dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS os_checklist (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    osId INTEGER NOT NULL,
    ordem INTEGER NOT NULL DEFAULT 0,
    descricao TEXT NOT NULL,
    obrigatorio INTEGER DEFAULT 0,
    concluido INTEGER DEFAULT 0,
    responsavel TEXT,
    dataConclusao TEXT,
    observacao TEXT,
    FOREIGN KEY (osId) REFERENCES os_ordens(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_os_checklist_os ON os_checklist(osId, ordem);

  CREATE TABLE IF NOT EXISTS os_anexos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    osId INTEGER NOT NULL,
    categoria TEXT NOT NULL,
    mimeType TEXT,
    nomeOriginal TEXT NOT NULL,
    caminho TEXT NOT NULL,
    tamanho INTEGER,
    uploadedBy TEXT,
    dataUpload TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (osId) REFERENCES os_ordens(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_os_anexos_os ON os_anexos(osId, categoria);

  CREATE TABLE IF NOT EXISTS os_eventos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    osId INTEGER NOT NULL,
    tipo TEXT NOT NULL,
    descricao TEXT,
    usuario TEXT,
    payload TEXT,
    data TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (osId) REFERENCES os_ordens(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_os_eventos_os ON os_eventos(osId, data DESC);

  CREATE TABLE IF NOT EXISTS os_notificacoes_config (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    evento TEXT NOT NULL,
    canal TEXT NOT NULL,
    template TEXT,
    ativo INTEGER DEFAULT 1,
    UNIQUE(evento, canal)
  );
`);

// ALTERs idempotentes em os_ordens (tenants existentes ganham colunas)
for (const col of [
  'tipoId INTEGER',
  'contratoId INTEGER',
  'oportunidadeId INTEGER',
  'osPaiId INTEGER',
  'enderecoExecucao TEXT',
  'numeroExecucao TEXT',
  'complementoExecucao TEXT',
  'bairroExecucao TEXT',
  'municipioExecucao TEXT',
  'ufExecucao TEXT',
  'cepExecucao TEXT',
  'prazoSLADias INTEGER',
  'dataPromessa TEXT',
  "slaStatus TEXT DEFAULT 'no-prazo'",
  "orcamentoStatus TEXT DEFAULT 'rascunho'",
  'orcamentoToken TEXT',
  'dataEnvioOrcamento TEXT',
  'dataRespostaOrcamento TEXT',
  'motivoRejeicao TEXT',
  'assinaturaClienteDataUrl TEXT',
  'assinaturaClienteData TEXT',
  'assinaturaTecnicoDataUrl TEXT',
  'assinaturaTecnicoData TEXT',
  'emGarantia INTEGER DEFAULT 0',
  "ambienteFiscal TEXT DEFAULT 'sefaz'",
  'kmPercorrido REAL',
  'valorDeslocamento REAL',
]) alterSafe(db, `ALTER TABLE os_ordens ADD COLUMN ${col}`);

alterSafe(db, 'CREATE UNIQUE INDEX IF NOT EXISTS idx_os_orcamento_token ON os_ordens(orcamentoToken) WHERE orcamentoToken IS NOT NULL');

// 2026-05-06: aquisição de peça/serviço de terceiro para uma OS.
// Replicado de os-routes.migrarDB para tenants existentes ganharem as
// colunas sem depender da 1ª chamada autenticada a /api/os.
for (const tab of ['os_itens_pecas', 'os_itens_servicos']) {
  for (const col of [
    'compradoTerceiro INTEGER DEFAULT 0',
    'fornecedorId INTEGER',
    'custoTerceiro REAL',
    'notaFiscalTerceiro TEXT',
    'dataCompraTerceiro TEXT',
    'formaPagamentoTerceiro TEXT',
    'dataVencimentoTerceiro TEXT',
    'contasPagarId INTEGER',
    'movEntradaTerceiroId INTEGER',
  ]) alterSafe(db, `ALTER TABLE ${tab} ADD COLUMN ${col}`);
}
alterSafe(db, 'CREATE INDEX IF NOT EXISTS idx_osip_terceiro ON os_itens_pecas(compradoTerceiro)');
alterSafe(db, 'CREATE INDEX IF NOT EXISTS idx_osis_terceiro ON os_itens_servicos(compradoTerceiro)');
// 2026-06-02: interesse.grupoId — usada pelo /api/interesse (LEFT JOIN grupos_palavras).
// Faltava em tenants antigos (existia só no 1bit) → "no such column: i.grupoId". Idempotente.
alterSafe(db, 'ALTER TABLE interesse ADD COLUMN grupoId INTEGER');

for (const col of ['osId INTEGER', 'osItemId INTEGER', 'osItemTipo TEXT']) {
  alterSafe(db, `ALTER TABLE contas_a_pagar ADD COLUMN ${col}`);
}
alterSafe(db, 'CREATE INDEX IF NOT EXISTS idx_cp_os ON contas_a_pagar(osId)');

// 2026-05-06 (parte 2): relaxa NOT NULL de os_itens_pecas.produtoId para
// permitir peça de terceiro com descrição livre (sem cadastro no catálogo).
// SQLite não aceita drop NOT NULL via ALTER — recria a tabela.
{
  const cols = db.prepare("PRAGMA table_info('os_itens_pecas')").all();
  const prod = cols.find((c) => c.name === 'produtoId');
  if (prod && prod.notnull === 1) {
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec(`
      CREATE TABLE os_itens_pecas_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        osId INTEGER NOT NULL,
        produtoId INTEGER,
        descricao TEXT NOT NULL,
        quantidade REAL NOT NULL,
        valorUnitario REAL NOT NULL,
        valorTotal REAL NOT NULL,
        loteId INTEGER,
        serialIds TEXT,
        movSaidaId INTEGER,
        compradoTerceiro INTEGER DEFAULT 0,
        fornecedorId INTEGER,
        custoTerceiro REAL,
        notaFiscalTerceiro TEXT,
        dataCompraTerceiro TEXT,
        formaPagamentoTerceiro TEXT,
        dataVencimentoTerceiro TEXT,
        contasPagarId INTEGER,
        movEntradaTerceiroId INTEGER,
        FOREIGN KEY (osId) REFERENCES os_ordens(id) ON DELETE CASCADE,
        FOREIGN KEY (produtoId) REFERENCES produtos(id),
        FOREIGN KEY (loteId) REFERENCES lotes(id)
      );
      INSERT INTO os_itens_pecas_new
        (id, osId, produtoId, descricao, quantidade, valorUnitario, valorTotal,
         loteId, serialIds, movSaidaId, compradoTerceiro, fornecedorId, custoTerceiro,
         notaFiscalTerceiro, dataCompraTerceiro, formaPagamentoTerceiro,
         dataVencimentoTerceiro, contasPagarId, movEntradaTerceiroId)
      SELECT id, osId, produtoId, descricao, quantidade, valorUnitario, valorTotal,
             loteId, serialIds, movSaidaId, compradoTerceiro, fornecedorId, custoTerceiro,
             notaFiscalTerceiro, dataCompraTerceiro, formaPagamentoTerceiro,
             dataVencimentoTerceiro, contasPagarId, movEntradaTerceiroId
      FROM os_itens_pecas;
      DROP TABLE os_itens_pecas;
      ALTER TABLE os_itens_pecas_new RENAME TO os_itens_pecas;
      CREATE INDEX IF NOT EXISTS idx_os_pecas_os ON os_itens_pecas(osId);
      CREATE INDEX IF NOT EXISTS idx_osip_terceiro ON os_itens_pecas(compradoTerceiro);
    `);
    db.exec('PRAGMA foreign_keys = ON');
  }
}

// 2026-06-02: relaxa NOT NULL de contas_receber_pagamentos.contaFinanceiraId
// para permitir bonificação (recebimento com desconto total → vPago=0, sem
// conta financeira e sem movimentação no caixa). SQLite exige rebuild.
{
  const cols = db.prepare("PRAGMA table_info('contas_receber_pagamentos')").all();
  const cf = cols.find((c) => c.name === 'contaFinanceiraId');
  if (cf && cf.notnull === 1) {
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec(`
      CREATE TABLE contas_receber_pagamentos_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        contaReceberId INTEGER NOT NULL,
        dataPagamento TEXT NOT NULL,
        valorPago REAL NOT NULL,
        valorBase REAL NOT NULL,
        juros REAL DEFAULT 0,
        multa REAL DEFAULT 0,
        desconto REAL DEFAULT 0,
        formaPagamento TEXT,
        contaFinanceiraId INTEGER,
        movimentacaoFinanceiraId INTEGER,
        observacoes TEXT,
        estornado INTEGER DEFAULT 0,
        estornadoEm TEXT,
        origem TEXT,
        usuario TEXT,
        dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (contaReceberId) REFERENCES contas_a_receber(id),
        FOREIGN KEY (contaFinanceiraId) REFERENCES contas_financeiras(id)
      );
      INSERT INTO contas_receber_pagamentos_new
        (id, contaReceberId, dataPagamento, valorPago, valorBase, juros, multa, desconto,
         formaPagamento, contaFinanceiraId, movimentacaoFinanceiraId, observacoes,
         estornado, estornadoEm, origem, usuario, dataCriacao)
      SELECT id, contaReceberId, dataPagamento, valorPago, valorBase, juros, multa, desconto,
             formaPagamento, contaFinanceiraId, movimentacaoFinanceiraId, observacoes,
             estornado, estornadoEm, origem, usuario, dataCriacao
      FROM contas_receber_pagamentos;
      DROP TABLE contas_receber_pagamentos;
      ALTER TABLE contas_receber_pagamentos_new RENAME TO contas_receber_pagamentos;
      CREATE INDEX IF NOT EXISTS idx_crp_conta ON contas_receber_pagamentos(contaReceberId);
    `);
    db.exec('PRAGMA foreign_keys = ON');
  }
}

// users: técnicos com especialidade / custo / comissão
for (const col of [
  'especialidade TEXT',
  'valorHora REAL',
  'comissaoPercentual REAL',
  'whatsappTecnico TEXT',
]) alterSafe(db, `ALTER TABLE users ADD COLUMN ${col}`);

// users: papel comercial (vendedor) — ortogonal ao role de autorização.
// vendedorTipo: 'interno' (CLT) | 'externo' (autônomo PF) | 'representante' (PJ).
// comissaoPercentual já existe acima e é compartilhado entre técnico e vendedor.
for (const col of [
  'ehVendedor INTEGER DEFAULT 0',
  'vendedorTipo TEXT',
  'cpfCnpj TEXT',
  'metaMensal REAL',
  'telefoneVendedor TEXT',
]) alterSafe(db, `ALTER TABLE users ADD COLUMN ${col}`);

// CRM / contratos: retornam link para OS
alterSafe(db, 'ALTER TABLE crm_oportunidades ADD COLUMN osId INTEGER');
// CRM: etapa que dispara agendamento (crm_atividade) ao receber um card
alterSafe(db, 'ALTER TABLE crm_etapas ADD COLUMN geraAgendamento INTEGER NOT NULL DEFAULT 0');
alterSafe(db, 'ALTER TABLE reservas_estoque ADD COLUMN osId INTEGER');
alterSafe(db, 'ALTER TABLE reservas_estoque ADD COLUMN osItemPecaId INTEGER');
alterSafe(db, 'CREATE INDEX IF NOT EXISTS idx_reservas_os ON reservas_estoque(osId) WHERE osId IS NOT NULL');
alterSafe(db, 'ALTER TABLE contratos ADD COLUMN osPadraoTipoId INTEGER');
alterSafe(db, 'ALTER TABLE contratos ADD COLUMN osPeriodicidadeDias INTEGER');
alterSafe(db, 'ALTER TABLE contratos ADD COLUMN osUltimaGeracao TEXT');

// Seed idempotente: 4 tipos de OS padrão por tenant
// (pode rodar N vezes sem duplicar, INSERT OR IGNORE no slug UNIQUE)
const _seedTipoOS = db.prepare(`
  INSERT OR IGNORE INTO os_tipos
    (nome, slug, descricao, modoFiscal, slaDiasPadrao, exigeEnderecoExec,
     exigeAssinaturaCliente, exigeOrcamentoAprovado, checklistPadrao, cor)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
for (const t of [
  {
    nome: 'Bancada', slug: 'bancada',
    descricao: 'Assistência técnica — cliente traz equipamento à loja',
    modoFiscal: 'sefaz', sla: 7,
    exigeEndereco: 0, exigeAssinatura: 1, exigeOrcamento: 1,
    checklist: JSON.stringify([
      { ordem: 1, descricao: 'Recebimento e inspeção visual', obrigatorio: 1 },
      { ordem: 2, descricao: 'Diagnóstico técnico', obrigatorio: 1 },
      { ordem: 3, descricao: 'Aprovação do orçamento pelo cliente', obrigatorio: 1 },
      { ordem: 4, descricao: 'Execução do reparo', obrigatorio: 1 },
      { ordem: 5, descricao: 'Testes de funcionamento', obrigatorio: 1 },
      { ordem: 6, descricao: 'Limpeza final', obrigatorio: 0 },
    ]),
    cor: '#4dabf7',
  },
  {
    nome: 'Campo', slug: 'campo',
    descricao: 'Visita técnica — técnico vai ao cliente',
    modoFiscal: 'sefaz', sla: 3,
    exigeEndereco: 1, exigeAssinatura: 1, exigeOrcamento: 0,
    checklist: JSON.stringify([
      { ordem: 1, descricao: 'Deslocamento ao local', obrigatorio: 1 },
      { ordem: 2, descricao: 'Foto ANTES da intervenção', obrigatorio: 1 },
      { ordem: 3, descricao: 'Execução do serviço', obrigatorio: 1 },
      { ordem: 4, descricao: 'Foto DEPOIS da intervenção', obrigatorio: 1 },
      { ordem: 5, descricao: 'Teste in loco com o cliente', obrigatorio: 1 },
      { ordem: 6, descricao: 'Assinatura de aceite do cliente', obrigatorio: 1 },
    ]),
    cor: '#51cf66',
  },
  {
    nome: 'Preventiva', slug: 'preventiva',
    descricao: 'Manutenção periódica sob contrato',
    modoFiscal: 'interno', sla: 30,
    exigeEndereco: 1, exigeAssinatura: 1, exigeOrcamento: 0,
    checklist: JSON.stringify([
      { ordem: 1, descricao: 'Inspeção geral', obrigatorio: 1 },
      { ordem: 2, descricao: 'Limpeza de componentes', obrigatorio: 1 },
      { ordem: 3, descricao: 'Verificação de folgas/desgaste', obrigatorio: 1 },
      { ordem: 4, descricao: 'Substituição de consumíveis', obrigatorio: 0 },
      { ordem: 5, descricao: 'Relatório final', obrigatorio: 1 },
    ]),
    cor: '#ffd43b',
  },
  {
    nome: 'Instalação', slug: 'instalacao',
    descricao: 'Projeto de instalação com etapas e aprovação de orçamento',
    modoFiscal: 'sefaz', sla: 30,
    exigeEndereco: 1, exigeAssinatura: 1, exigeOrcamento: 1,
    checklist: JSON.stringify([
      { ordem: 1, descricao: 'Visita técnica preliminar', obrigatorio: 1 },
      { ordem: 2, descricao: 'Orçamento detalhado aprovado', obrigatorio: 1 },
      { ordem: 3, descricao: 'Aquisição de materiais', obrigatorio: 1 },
      { ordem: 4, descricao: 'Execução da instalação', obrigatorio: 1 },
      { ordem: 5, descricao: 'Testes operacionais', obrigatorio: 1 },
      { ordem: 6, descricao: 'Treinamento do cliente', obrigatorio: 0 },
      { ordem: 7, descricao: 'Entrega formal + assinatura', obrigatorio: 1 },
    ]),
    cor: '#845ef7',
  },
  {
    nome: 'Garantia', slug: 'garantia',
    descricao: 'OS gerada dentro do período de garantia — sem cobrança',
    modoFiscal: 'interno', sla: 5,
    exigeEndereco: 0, exigeAssinatura: 1, exigeOrcamento: 0,
    checklist: JSON.stringify([
      { ordem: 1, descricao: 'Verificar elegibilidade da garantia', obrigatorio: 1 },
      { ordem: 2, descricao: 'Diagnóstico do defeito', obrigatorio: 1 },
      { ordem: 3, descricao: 'Reparo ou troca', obrigatorio: 1 },
      { ordem: 4, descricao: 'Teste de funcionamento', obrigatorio: 1 },
    ]),
    cor: '#ff6b6b',
  },
]) {
  _seedTipoOS.run(
    t.nome, t.slug, t.descricao, t.modoFiscal, t.sla,
    t.exigeEndereco, t.exigeAssinatura, t.exigeOrcamento,
    t.checklist, t.cor,
  );
}

// ==================== PESSOAS (enriquecimento ERP — 2026-04-23) ====================
// Colunas escalares adicionais e 4 tabelas 1:N. Idempotente via alterSafe e
// CREATE IF NOT EXISTS. Tabela `pessoas` base é criada em financeiro-routes.js
// (migrarDB) no boot — aqui só estendemos. Se o tenant ainda não tem pessoas,
// o CREATE abaixo garante (schema compatível).
db.exec(`
  CREATE TABLE IF NOT EXISTS pessoas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cpfCnpj TEXT NOT NULL,
    tipo TEXT NOT NULL DEFAULT 'PJ',
    razaoSocial TEXT NOT NULL,
    nomeFantasia TEXT,
    inscricaoMunicipal TEXT,
    endereco TEXT, numero TEXT, complemento TEXT, bairro TEXT,
    codigoMunicipio TEXT, cidade TEXT, uf TEXT, cep TEXT,
    telefone TEXT, email TEXT, observacoes TEXT,
    ativo INTEGER DEFAULT 1,
    dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
    dataAtualizacao TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_pessoas_cpfcnpj ON pessoas(cpfCnpj);
`);

// Identificação fiscal (SEFAZ)
for (const col of [
  'indicadorIE INTEGER',                              // 1=contrib, 2=isento, 9=nao contrib
  'suframa TEXT',                                     // Zona Franca Manaus
  'cnaePrincipal TEXT',
  'cnaeDescricao TEXT',
  'naturezaJuridicaCodigo TEXT',
  'naturezaJuridicaDescricao TEXT',
  'porte TEXT',                                       // MEI/ME/EPP/DEMAIS
  'regimeTributario INTEGER',                         // 1=SN, 2=SN-excesso, 3=Normal, 4=MEI
  'optanteSimples INTEGER DEFAULT 0',
  'dataAberturaNascimento TEXT',
  'capitalSocial REAL',
  'situacaoCadastralReceita TEXT',
  'dataUltimaConsultaReceita TEXT',
  'logo TEXT',
  'inscricaoEstadual TEXT',                           // já pode existir (compat)
  'contribuinteIcms INTEGER DEFAULT 0',               // compat legado
  'cobrancaAtiva INTEGER DEFAULT 1',                  // compat legado
  'emailsAdicionais TEXT',                            // compat legado
  // Pessoa Física
  'rg TEXT',
  'rgOrgaoEmissor TEXT',
  'rgDataExpedicao TEXT',
  'dataNascimento TEXT',
  'sexo TEXT',
  'estadoCivil TEXT',
  'profissao TEXT',
  'nomeMae TEXT',
  'nomePai TEXT',
  "nacionalidade TEXT DEFAULT 'Brasileira'",
  // Classificação comercial
  'categorias TEXT',                                   // JSON array
  'origem TEXT',
  'vendedorId INTEGER',
  'limiteCredito REAL',
  'prazoMedioDias INTEGER',
  'condicaoPagamentoPadrao TEXT',
  'tags TEXT',                                         // JSON array
  // LGPD
  'lgpdConsentimento INTEGER DEFAULT 0',
  'lgpdDataConsentimento TEXT',
  'lgpdFonte TEXT',
  'aceitaEmailMarketing INTEGER DEFAULT 0',
  'aceitaWhatsappMarketing INTEGER DEFAULT 0',
  // Administrativo
  'dataInativacao TEXT',
  'motivoInativacao TEXT',
]) {
  alterSafe(db, `ALTER TABLE pessoas ADD COLUMN ${col}`);
}

// Contatos múltiplos por área
db.exec(`
  CREATE TABLE IF NOT EXISTS pessoas_contatos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pessoaId INTEGER NOT NULL,
    nome TEXT NOT NULL,
    cargo TEXT,
    area TEXT,
    telefone TEXT,
    celular TEXT,
    email TEXT,
    whatsapp TEXT,
    principal INTEGER DEFAULT 0,
    observacoes TEXT,
    ativo INTEGER DEFAULT 1,
    dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
    dataAtualizacao TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (pessoaId) REFERENCES pessoas(id)
  );
  CREATE INDEX IF NOT EXISTS idx_pessoas_contatos_pessoaId ON pessoas_contatos(pessoaId);
`);

// Endereços adicionais (entrega/cobrança além do fiscal)
db.exec(`
  CREATE TABLE IF NOT EXISTS pessoas_enderecos_adicionais (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pessoaId INTEGER NOT NULL,
    tipo TEXT NOT NULL,
    apelido TEXT,
    endereco TEXT,
    numero TEXT,
    complemento TEXT,
    bairro TEXT,
    cidade TEXT,
    uf TEXT,
    cep TEXT,
    codigoMunicipio TEXT,
    pais TEXT DEFAULT 'BR',
    padrao INTEGER DEFAULT 0,
    ativo INTEGER DEFAULT 1,
    dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (pessoaId) REFERENCES pessoas(id)
  );
  CREATE INDEX IF NOT EXISTS idx_pessoas_enderecos_pessoaId ON pessoas_enderecos_adicionais(pessoaId);
`);

// Dados bancários + PIX (múltiplos por pessoa)
db.exec(`
  CREATE TABLE IF NOT EXISTS pessoas_dados_bancarios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pessoaId INTEGER NOT NULL,
    banco TEXT,
    codigoBanco TEXT,
    agencia TEXT,
    agenciaDv TEXT,
    conta TEXT,
    contaDv TEXT,
    tipoConta TEXT,
    titular TEXT,
    cpfCnpjTitular TEXT,
    chavePix TEXT,
    tipoChavePix TEXT,
    padrao INTEGER DEFAULT 0,
    observacoes TEXT,
    ativo INTEGER DEFAULT 1,
    dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (pessoaId) REFERENCES pessoas(id)
  );
  CREATE INDEX IF NOT EXISTS idx_pessoas_bancarios_pessoaId ON pessoas_dados_bancarios(pessoaId);
`);

// Anexos (contratos, procurações, CND, etc) — arquivo em disco
db.exec(`
  CREATE TABLE IF NOT EXISTS pessoas_anexos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pessoaId INTEGER NOT NULL,
    nome TEXT NOT NULL,
    tipo TEXT,
    caminho TEXT NOT NULL,
    tamanhoBytes INTEGER,
    mimeType TEXT,
    descricao TEXT,
    uploadUserId INTEGER,
    dataUpload TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (pessoaId) REFERENCES pessoas(id)
  );
  CREATE INDEX IF NOT EXISTS idx_pessoas_anexos_pessoaId ON pessoas_anexos(pessoaId);
`);

// Certidões & Habilitação (2026-07-09): documentos de habilitação da empresa
// para licitações (Lei 14.133/2021) — jurídica, fiscal, econômico-financeira,
// técnica. Status derivado da dataValidade (não persistido). Schema-fonte fica
// aqui para aplicar por-tenant no boot; habilitacao-routes.migrarDB é no-op no
// proxy multi-tenant. Ver [[project_erp_solution_gap_analysis]].
db.exec(`
  CREATE TABLE IF NOT EXISTS habilitacao_documentos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    categoria TEXT NOT NULL,
    tipo TEXT NOT NULL,
    esfera TEXT,
    orgaoEmissor TEXT,
    numero TEXT,
    dataEmissao TEXT,
    dataValidade TEXT,
    arquivo TEXT,
    arquivoNome TEXT,
    arquivoMime TEXT,
    arquivoTamanho INTEGER,
    origem TEXT NOT NULL DEFAULT 'manual',
    ultimaBuscaAuto TEXT,
    observacoes TEXT,
    ativo INTEGER DEFAULT 1,
    dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
    dataAtualizacao TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_habilitacao_cat ON habilitacao_documentos(categoria, ativo);
  CREATE INDEX IF NOT EXISTS idx_habilitacao_validade ON habilitacao_documentos(dataValidade);
`);
// Multi-loja (Fase 3): a qual estabelecimento a certidão pertence (NULL = matriz).
// A regra de herança (federal → matriz para filial da mesma PJ; estadual/municipal
// → CNPJ próprio) vive em habilitacao-cnpj.js.
alterSafe(db, 'ALTER TABLE habilitacao_documentos ADD COLUMN estabelecimentoId INTEGER');

// NF-e de devolução (2026-04-23): faturas podem ser "virtuais" de
// devolução — vinculadas a devolucoes, com finNFe=4 e tpNF=0. A
// coluna refNFeOriginal armazena a chave da NF-e da venda original
// (44 chars) para inclusão no grupo NFref.
alterSafe(db, 'ALTER TABLE faturas ADD COLUMN isDevolucao INTEGER DEFAULT 0');
alterSafe(db, 'ALTER TABLE faturas ADD COLUMN devolucaoId INTEGER');
alterSafe(db, 'ALTER TABLE faturas ADD COLUMN refNFeOriginal TEXT');

// Auditoria de tokens (2026-05-27): /api/auth/token também grava em
// bearer_history quando o token é REJEITADO (validação Comprasnet falha).
// Antes só logava — agora deixa rastro pra distinguir "token nunca chegou"
// de "chegou e foi recusado".
alterSafe(db, 'ALTER TABLE bearer_history ADD COLUMN motivoRejeicao TEXT');
alterSafe(db, 'ALTER TABLE bearer_history ADD COLUMN httpStatusRejeicao INTEGER');

// Tabelas do robô SC (cotacao.licitacao.sc.gov.br) — Phase 2 do robô SC,
// mantidas em arquivo separado para isolar do schema principal.
require('./sc-schema').initSCSchema(db);

// Tabelas BNC (bnccompras.com) — Fase 5 do conector BNC. Mesma motivação:
// arquivo separado pra isolar do schema principal.
require('./bnc-schema').initBNCSchema(db);

// Tabelas BLL (bllcompras.com) — conector BLL (proposta + lance). Mesmo padrão.
require('./bll-schema').initBLLSchema(db);

}

module.exports = { initSchema };
