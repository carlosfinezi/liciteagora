// bnc-schema.js
//
// Schema de tabelas BNC (bnccompras.com) — Fase 5 do conector BNC.
// Espelha pattern de sc-schema.js: módulo isolado, chamado por db-schema.js
// no bootstrap do tenant DB.
//
// Tabelas:
//   bnc_salas       — sala de disputa cadastrada pelo tenant
//                     (1 sala = 1 processo BNC; pode ter N lotes)
//   bnc_salas_lotes — cada lote da sala (alimentado pelo SignalR)
//
// compraId interno (pra integrar com sniper/lances.html):
//   formato 'bnc:<ProcessNumber>' (ex: 'bnc:000000332026')
//   prefix 'bnc:' permite roteamento transparent em /api/sniper/lance

'use strict';

function initBNCSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS bnc_salas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      compraId TEXT NOT NULL UNIQUE,          -- 'bnc:<ProcessNumber>'
      processId TEXT NOT NULL,                -- [gkz] token Pid
      uid TEXT NOT NULL,                      -- [gkz] token Uid (userId/perfil)
      processNumber TEXT,                     -- '000000332026'
      title TEXT,                             -- 'FESURV - UNIVERSIDADE...'
      statusName TEXT,                        -- 'DISPUTA'|'AGUARDANDO DISPUTA'|...
      ativo INTEGER NOT NULL DEFAULT 1,       -- 1=scheduler vai instanciar engine
      url TEXT,                               -- URL original colada pelo user
      cadastradoEm TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      notas TEXT
    );

    -- Idempotente: ALTER ADD COLUMN só roda se a coluna não existir.
    -- SQLite não tem IF NOT EXISTS pra ALTER, então o pragma é usado em
    -- bnc-schema.js abaixo.

    CREATE INDEX IF NOT EXISTS idx_bnc_salas_ativo ON bnc_salas(ativo);
    CREATE INDEX IF NOT EXISTS idx_bnc_salas_processNumber ON bnc_salas(processNumber);

    CREATE TABLE IF NOT EXISTS bnc_salas_lotes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      salaId INTEGER NOT NULL REFERENCES bnc_salas(id) ON DELETE CASCADE,
      idBatchUuid TEXT,                       -- UUID v4 do SignalR (vem em updateStatus.idBatch)
      batchTokenGkz TEXT,                     -- [gkz] token pra PerformBid (do hidden field FastBid)
      batchNumber INTEGER,                    -- 1, 2, 3, ...
      title TEXT,                             -- 'LOTE 1'
      baseValue REAL,                         -- valor de referência
      currentBest REAL,                       -- melhor lance atual
      fkParticipantLider TEXT,                -- UUID do participante líder
      winnerBidderId TEXT,                    -- 'PARTICIPANTE 699' (anonimizado)
      isWinner INTEGER DEFAULT 0,             -- 1 se sou eu o líder atual
      offers INTEGER DEFAULT 0,
      lastUpdate TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_bnc_salas_lotes_salaId ON bnc_salas_lotes(salaId);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_bnc_salas_lotes_uuid ON bnc_salas_lotes(salaId, idBatchUuid) WHERE idBatchUuid IS NOT NULL;

    -- Config de auto-lance por lote. 1:1 com bnc_salas_lotes via UNIQUE(loteId).
    -- Quando ativo=1, scheduler dispara sendBid() conforme regras.
    -- Quando dryRun=1, engine só loga (não envia PerformBid de fato).
    CREATE TABLE IF NOT EXISTS bnc_auto_lance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      loteId INTEGER NOT NULL UNIQUE REFERENCES bnc_salas_lotes(id) ON DELETE CASCADE,
      ativo INTEGER NOT NULL DEFAULT 0,        -- 0=desligado, 1=robô vai dar lance
      dryRun INTEGER NOT NULL DEFAULT 1,       -- 1=só loga, 0=envia PerformBid real
      limiteMinimo REAL NOT NULL DEFAULT 0,    -- piso (não baixa abaixo)
      decremento REAL NOT NULL DEFAULT 1,      -- valor subtraído do melhorAtual a cada lance
      throttleMs INTEGER NOT NULL DEFAULT 2000,-- mínimo entre lances
      atualizadoEm TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_bnc_auto_lance_ativo ON bnc_auto_lance(ativo);

    -- Rastreio de envio de PROPOSTA. Idempotência por (processId).
    -- 'enviada' só vira 1 num POST real (dryRun=0) bem-sucedido.
    -- Espelha bll_propostas (bll-schema.js).
    CREATE TABLE IF NOT EXISTS bnc_propostas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      compraId TEXT,                          -- 'bnc:<ProcessNumber>' quando conhecido
      processId TEXT NOT NULL UNIQUE,         -- [gkz] token do processo (chave de idempotência)
      participantId TEXT,
      fkRepresentant TEXT,
      isMe INTEGER DEFAULT 1,
      itensJson TEXT,                         -- JSON [{idBatchItem, valor}]
      payloadJson TEXT,                       -- payload form montado (auditoria)
      dryRun INTEGER NOT NULL DEFAULT 1,
      enviada INTEGER NOT NULL DEFAULT 0,     -- 1 = POST real OK
      status TEXT,                            -- 'previa'|'enviada'|'erro'
      httpStatus INTEGER,
      respostaResumo TEXT,                    -- trecho da resposta / DataResult
      comprovanteUrl TEXT,                    -- ReportPage.aspx, se capturado
      criadoEm TEXT NOT NULL,
      atualizadoEm TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_bnc_propostas_compraId ON bnc_propostas(compraId);

    -- Mensagens da sala de disputa (chat do lote + avisos do condutor/processo),
    -- capturadas de /BatchListParticipant/ParticipantBatchMessage. Dedup por hash;
    -- notificadoTelegram controla o encaminhamento (backfill inicial = silencioso).
    CREATE TABLE IF NOT EXISTS bnc_dispute_mensagens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      salaId INTEGER,
      idBatch TEXT,
      bloco TEXT NOT NULL,                    -- 'PROCESSO' (condutor) | 'LOTE' (chat)
      horario TEXT,                           -- '14/07/2026 11:19:58'
      remetente TEXT,                         -- 'PREGOEIRO'|'PARTICIPANTE N'|null (processo)
      texto TEXT NOT NULL,
      hash TEXT NOT NULL UNIQUE,              -- dedup idempotente
      notificadoTelegram INTEGER NOT NULL DEFAULT 0,
      criadoEm TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_bnc_msg_sala ON bnc_dispute_mensagens(salaId, notificadoTelegram);
  `);

  // Migração idempotente: adiciona coluna dryRun em bnc_salas se ainda
  // não existir. SQLite não tem ALTER ADD COLUMN IF NOT EXISTS.
  const cols = db.prepare("PRAGMA table_info(bnc_salas)").all();
  const hasDryRun = cols.some(c => c.name === 'dryRun');
  if (!hasDryRun) {
    db.exec(`ALTER TABLE bnc_salas ADD COLUMN dryRun INTEGER NOT NULL DEFAULT 1`);
  }

  // Payload estável do UpdateStatus (UUIDs) por lote — usado pra buscar as
  // mensagens do pregão via ConvertBatchDataToViewModel mesmo fora da fase de
  // lances (negociação) e após restart, sem depender de UpdateStatus ao vivo.
  const loteCols = db.prepare("PRAGMA table_info(bnc_salas_lotes)").all();
  if (!loteCols.some(c => c.name === 'statusPayloadJson')) {
    db.exec(`ALTER TABLE bnc_salas_lotes ADD COLUMN statusPayloadJson TEXT`);
  }
}

module.exports = { initBNCSchema };
