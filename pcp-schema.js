// pcp-schema.js
//
// Migrations idempotentes para as tabelas que o monitor do PCP usa.
// Rodam na primeira vez que o agendador toca o DB do tenant.

function migratePcpSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pcp_pregoes (
      chave_id          TEXT PRIMARY KEY,
      numero            TEXT,
      numero_longo      TEXT,
      unidade           TEXT,
      objeto            TEXT,
      tipo_sigla        TEXT,
      tipo_completo     TEXT,
      abertura          TEXT,
      situacao          TEXT,          -- da listagem (Aberto, Processo Finalizado, ...)
      situacao_api      TEXT,          -- do endpoint /operacao (Aberta, Encerrada, ...)
      ultimo_chat_id    INTEGER DEFAULT 0,
      ativo             INTEGER DEFAULT 1,  -- 0 quando o monitor pode parar de consultar
      primeiro_visto_em TEXT,
      atualizado_em     TEXT
    );

    CREATE TABLE IF NOT EXISTS pcp_mensagens (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      chave_id             TEXT NOT NULL,
      mensagem_id          INTEGER NOT NULL,   -- id que vem da API PCP
      data                 TEXT,
      hora                 TEXT,
      nome_remetente       TEXT,
      texto                TEXT,
      telegram_enviado_em  TEXT,
      criado_em            TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(chave_id, mensagem_id)
    );

    CREATE INDEX IF NOT EXISTS idx_pcp_mensagens_chave ON pcp_mensagens(chave_id, criado_em DESC);
    CREATE INDEX IF NOT EXISTS idx_pcp_pregoes_ativo ON pcp_pregoes(ativo);

    CREATE TABLE IF NOT EXISTS pcp_propostas (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      chave_id        TEXT NOT NULL UNIQUE,   -- ttCD_CHAVE do processo
      compra_id       TEXT,                   -- 'pcp:<chave>' p/ rastreio
      pncp            TEXT,                   -- CNPJ-ANO-SEQ do edital
      epp             INTEGER DEFAULT 0,      -- declarou ME/EPP
      validade        INTEGER,                -- validade da proposta (dias)
      itens_json      TEXT,
      payload_json    TEXT,
      dry_run         INTEGER DEFAULT 1,
      enviada         INTEGER DEFAULT 0,
      status          TEXT,                   -- previa | enviada | erro
      http_status     INTEGER,
      resposta_resumo TEXT,
      criado_em       TEXT,
      atualizado_em   TEXT
    );
  `);
}

module.exports = { migratePcpSchema };
