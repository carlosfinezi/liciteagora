// bll-schema.js
//
// Schema de tabelas BLL (bllcompras.com) — conector BLL.
// Espelha bnc-schema.js: módulo isolado, chamado por db-schema.js no bootstrap
// do tenant DB.
//
// Tabelas:
//   bll_salas       — sala de disputa cadastrada pelo tenant (1 sala = 1 processo)
//   bll_salas_lotes — cada lote da sala (alimentado pelo SignalR na Fase 3)
//   bll_auto_lance  — config de auto-lance por lote (Fase 3; dryRun=1 default)
//   bll_propostas   — rastreio/idempotência/comprovante do envio de proposta (Fase 2)
//
// compraId interno (pra integrar com sniper/lances.html):
//   formato 'bll:<ProcessNumber>' — prefix 'bll:' roteia transparente.
//
// NOTA: bll_salas/bll_salas_lotes/bll_auto_lance são pré-criadas aqui para o
// motor de lance da Fase 3; nesta entrega só bll_propostas é exercitada.

'use strict';

function initBLLSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS bll_salas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      compraId TEXT NOT NULL UNIQUE,          -- 'bll:<ProcessNumber>'
      processId TEXT NOT NULL,                -- [gkz] token do processo
      uid TEXT,                               -- token do participante/perfil, se houver
      processNumber TEXT,                     -- '0032026'
      title TEXT,
      statusName TEXT,                        -- 'DISPUTA'|'RECEPCAO'|...
      ativo INTEGER NOT NULL DEFAULT 1,       -- 1=scheduler instancia engine (Fase 3)
      dryRun INTEGER NOT NULL DEFAULT 1,
      url TEXT,
      cadastradoEm TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      notas TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_bll_salas_ativo ON bll_salas(ativo);
    CREATE INDEX IF NOT EXISTS idx_bll_salas_processNumber ON bll_salas(processNumber);

    CREATE TABLE IF NOT EXISTS bll_salas_lotes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      salaId INTEGER NOT NULL REFERENCES bll_salas(id) ON DELETE CASCADE,
      idBatchUuid TEXT,
      batchTokenGkz TEXT,
      batchNumber INTEGER,
      title TEXT,
      baseValue REAL,
      currentBest REAL,
      fkParticipantLider TEXT,
      winnerBidderId TEXT,
      isWinner INTEGER DEFAULT 0,
      offers INTEGER DEFAULT 0,
      lastUpdate TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_bll_salas_lotes_salaId ON bll_salas_lotes(salaId);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_bll_salas_lotes_uuid ON bll_salas_lotes(salaId, idBatchUuid) WHERE idBatchUuid IS NOT NULL;

    CREATE TABLE IF NOT EXISTS bll_auto_lance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      loteId INTEGER NOT NULL UNIQUE REFERENCES bll_salas_lotes(id) ON DELETE CASCADE,
      ativo INTEGER NOT NULL DEFAULT 0,
      dryRun INTEGER NOT NULL DEFAULT 1,
      limiteMinimo REAL NOT NULL DEFAULT 0,
      decremento REAL NOT NULL DEFAULT 1,
      throttleMs INTEGER NOT NULL DEFAULT 2000,
      atualizadoEm TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_bll_auto_lance_ativo ON bll_auto_lance(ativo);

    -- Rastreio de envio de PROPOSTA (Fase 2). Idempotência por (processId).
    -- 'enviada' só vira 1 num POST real (dryRun=0) bem-sucedido.
    CREATE TABLE IF NOT EXISTS bll_propostas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      compraId TEXT,                          -- 'bll:<ProcessNumber>' quando conhecido
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

    CREATE INDEX IF NOT EXISTS idx_bll_propostas_compraId ON bll_propostas(compraId);
  `);
}

module.exports = { initBLLSchema };
