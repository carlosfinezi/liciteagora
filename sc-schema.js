/**
 * sc-schema.js — Tabelas do robô SC (cotacao.licitacao.sc.gov.br).
 *
 * Tudo prefixado `sc_` para conviver com as tabelas do Comprasnet.
 * Chamado a partir de db-schema.js → initSchema(db) — ou manualmente
 * pelas rotas durante desenvolvimento.
 */

function initSCSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sc_participacoes (
      cotacaoId         INTEGER PRIMARY KEY,
      apelido           TEXT,
      numeroEdital      INTEGER,
      anoEdital         INTEGER,
      orgaoSigla        TEXT,
      orgaoDescricao    TEXT,
      unidadeSigla      TEXT,
      unidadeDescricao  TEXT,
      objeto            TEXT,
      cotacao           TEXT,
      situacao          TEXT,
      resultadoProcesso TEXT,
      cotacaoPorItem    INTEGER,
      casasDecimais     INTEGER,
      dataInicioLances  TEXT,
      dataFimLances     TEXT,
      dataPublicacao    TEXT,
      ativo             INTEGER DEFAULT 1,
      ciclosAusente     INTEGER DEFAULT 0,
      descobertoEm      TEXT DEFAULT (CURRENT_TIMESTAMP),
      ultimaSync        TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_sc_participacoes_ativo ON sc_participacoes(ativo);
    CREATE INDEX IF NOT EXISTS idx_sc_participacoes_situacao ON sc_participacoes(situacao);

    CREATE TABLE IF NOT EXISTS sc_lotes_cache (
      cotacaoId            INTEGER NOT NULL,
      loteId               INTEGER NOT NULL,
      numero               INTEGER,
      descricao            TEXT,
      situacao             TEXT,
      melhorLance          NUMERIC,
      melhorColocado       TEXT,
      ajustePrecosAprovado INTEGER,
      meuMelhorLance       NUMERIC,
      ultimaSync           TEXT DEFAULT (CURRENT_TIMESTAMP),
      PRIMARY KEY (cotacaoId, loteId)
    );

    CREATE TABLE IF NOT EXISTS sc_chat_mensagens (
      id                  INTEGER PRIMARY KEY,
      cotacaoId           INTEGER NOT NULL,
      remetente           TEXT,
      tipoRemetente       TEXT,
      mensagem            TEXT,
      dataCriacao         TEXT,
      chatBloqueado       INTEGER,
      notificadoTelegram  INTEGER DEFAULT 0,
      capturadoEm         TEXT DEFAULT (CURRENT_TIMESTAMP)
    );
    CREATE INDEX IF NOT EXISTS idx_sc_chat_cotacao ON sc_chat_mensagens(cotacaoId);
    CREATE INDEX IF NOT EXISTS idx_sc_chat_pendente_notif ON sc_chat_mensagens(notificadoTelegram, tipoRemetente);

    CREATE TABLE IF NOT EXISTS sc_sync_state (
      job              TEXT PRIMARY KEY,
      ultimaExecucao   TEXT,
      ultimoStatus     TEXT,
      ultimoErro       TEXT,
      detalhes         TEXT
    );

    -- Phase 3: motor sniper.
    -- Cada linha é uma "intenção de lance" amarrada a um lote (ou item) de uma
    -- cotação em que somos participantes. O scheduler observa dataFimLances e,
    -- antecedenciaMs antes do fim, dispara o POST. Após disparar, preenche
    -- disparadoEm para impedir re-fire.
    CREATE TABLE IF NOT EXISTS sc_sniper_config (
      cotacaoId       INTEGER NOT NULL,
      loteOuItemId    INTEGER NOT NULL,   -- id do lote OU do item conforme cotacaoPorItem
      valor           NUMERIC NOT NULL,
      antecedenciaMs  INTEGER DEFAULT 1500,
      ativo           INTEGER DEFAULT 1,
      disparadoEm     TEXT,
      observacao      TEXT,
      criadoEm        TEXT DEFAULT (CURRENT_TIMESTAMP),
      atualizadoEm    TEXT DEFAULT (CURRENT_TIMESTAMP),
      PRIMARY KEY (cotacaoId, loteOuItemId)
    );

    CREATE TABLE IF NOT EXISTS sc_sniper_historico (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      cotacaoId       INTEGER NOT NULL,
      loteOuItemId    INTEGER NOT NULL,
      valor           NUMERIC NOT NULL,
      fonte           TEXT,         -- 'sniper-auto' | 'manual'
      status          TEXT,         -- 'sucesso' | 'erro' | 'rede'
      httpStatus      INTEGER,
      resposta        TEXT,
      tempoMs         INTEGER,
      agendadoPara    TEXT,         -- ISO do alvo planejado (calcular drift)
      disparadoEm     TEXT DEFAULT (CURRENT_TIMESTAMP)
    );
    CREATE INDEX IF NOT EXISTS idx_sc_sniper_hist_cotacao ON sc_sniper_historico(cotacaoId, loteOuItemId);
  `);
}

module.exports = { initSCSchema };
