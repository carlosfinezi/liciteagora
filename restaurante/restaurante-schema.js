/**
 * restaurante-schema.js — Schema do módulo Restaurante (vertical).
 *
 * Modelo: NÃO altera tabelas core. O item vendável continua sendo `produtos`
 * (herda NCM/CFOP/CST, motor de tributação, estoque e NFC-e de graça); tudo
 * que é específico do segmento mora em tabelas `rest_*` que referenciam
 * `produtos` por FK.
 *
 *   produtos (core)
 *     ├── rest_produto_config  (1:1 — setor de produção, tempo, pesável)
 *     ├── rest_cardapio_itens  (N:1 — preço por canal/cardápio)
 *     └── rest_fichas          (1:1 — ficha técnica, insumos por FK a produtos)
 *
 * Uma comanda serve as cinco operações via `rest_comandas.tipo`:
 *   mesa | individual | balcao | delivery
 * A diferença entre à la carte, bar, fast-food, quilo e delivery é
 * configuração e canal — não fluxo paralelo.
 *
 * IMPORTANTE — por que este arquivo é chamado pelo db-schema.js:
 * o migrarDB() de um *-routes.js roda dentro do runInBootContext contra o
 * BOOT_STUB e é no-op em multi-tenant; não alcança nenhum dos tenants
 * existentes. Quem aplica schema em tenant existente é o db-schema.js.
 * Este módulo é chamado de lá (padrão do fiscal-trib-schema).
 *
 * Todo o schema das fases 0..9 é criado de uma vez, de propósito: tabela vazia
 * não custa nada e evita um restart de produção por fase.
 */

// CREATE TABLE tolerante: o schema roda em 11 tenants com históricos diferentes.
function execSafe(db, sql) {
  try {
    db.exec(sql);
  } catch (e) {
    if (/duplicate column/i.test(e.message)) return;
    if (/already exists/i.test(e.message)) return;
    throw e;
  }
}

function alterSafe(db, sql) {
  try {
    db.exec(sql);
  } catch (e) {
    if (/duplicate column/i.test(e.message)) return;
    if (/no such table/i.test(e.message)) return;
    throw e;
  }
}

function initRestauranteSchema(db) {
  // ==================== SALÃO: ÁREAS, MESAS, SETORES ====================

  execSafe(db, `
    CREATE TABLE IF NOT EXISTS rest_areas (
      id     INTEGER PRIMARY KEY AUTOINCREMENT,
      nome   TEXT NOT NULL,
      ordem  INTEGER NOT NULL DEFAULT 0,
      ativo  INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS rest_mesas (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      areaId      INTEGER,
      numero      TEXT NOT NULL UNIQUE,
      capacidade  INTEGER NOT NULL DEFAULT 4,
      posX        INTEGER NOT NULL DEFAULT 0,
      posY        INTEGER NOT NULL DEFAULT 0,
      ativo       INTEGER NOT NULL DEFAULT 1,
      FOREIGN KEY (areaId) REFERENCES rest_areas(id)
    );
    CREATE INDEX IF NOT EXISTS idx_rest_mesas_area ON rest_mesas(areaId);

    -- Setor de produção: chapa, bar, sobremesa, sushi, expedição.
    -- É o que separa as filas do KDS.
    CREATE TABLE IF NOT EXISTS rest_setores (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      codigo  TEXT NOT NULL UNIQUE,
      nome    TEXT NOT NULL,
      ordem   INTEGER NOT NULL DEFAULT 0,
      ativo   INTEGER NOT NULL DEFAULT 1
    );
  `);

  // ==================== CARDÁPIO ====================

  execSafe(db, `
    -- canal: salao | balcao | delivery | quilo
    CREATE TABLE IF NOT EXISTS rest_cardapios (
      id     INTEGER PRIMARY KEY AUTOINCREMENT,
      nome   TEXT NOT NULL,
      canal  TEXT NOT NULL DEFAULT 'salao',
      ordem  INTEGER NOT NULL DEFAULT 0,
      ativo  INTEGER NOT NULL DEFAULT 1
    );

    -- O preço mora aqui, não em produtos: o mesmo prato custa diferente no
    -- salão e no delivery (a taxa da plataforma entra no preço).
    CREATE TABLE IF NOT EXISTS rest_cardapio_itens (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      cardapioId  INTEGER NOT NULL,
      produtoId   INTEGER NOT NULL,
      categoria   TEXT,
      preco       REAL NOT NULL DEFAULT 0,
      ordem       INTEGER NOT NULL DEFAULT 0,
      disponivel  INTEGER NOT NULL DEFAULT 1,
      UNIQUE (cardapioId, produtoId),
      FOREIGN KEY (cardapioId) REFERENCES rest_cardapios(id) ON DELETE CASCADE,
      FOREIGN KEY (produtoId)  REFERENCES produtos(id)
    );
    CREATE INDEX IF NOT EXISTS idx_rest_card_itens_card ON rest_cardapio_itens(cardapioId);
    CREATE INDEX IF NOT EXISTS idx_rest_card_itens_prod ON rest_cardapio_itens(produtoId);

    -- Cardápio por faixa de horário (almoço, jantar, happy hour).
    -- diaSemana: 0=domingo .. 6=sábado; NULL = todos os dias.
    CREATE TABLE IF NOT EXISTS rest_cardapio_horarios (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      cardapioId  INTEGER NOT NULL,
      diaSemana   INTEGER,
      horaIni     TEXT NOT NULL,
      horaFim     TEXT NOT NULL,
      FOREIGN KEY (cardapioId) REFERENCES rest_cardapios(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_rest_card_hor_card ON rest_cardapio_horarios(cardapioId);

    -- Grupos de opção: "Ponto da carne" (1..1), "Adicionais" (0..5).
    CREATE TABLE IF NOT EXISTS rest_grupos_opcao (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      nome          TEXT NOT NULL,
      minEscolhas   INTEGER NOT NULL DEFAULT 0,
      maxEscolhas   INTEGER NOT NULL DEFAULT 1,
      ordem         INTEGER NOT NULL DEFAULT 0,
      ativo         INTEGER NOT NULL DEFAULT 1
    );

    -- insumoProdutoId: quando a opção consome estoque próprio (bacon extra).
    CREATE TABLE IF NOT EXISTS rest_opcoes (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      grupoId           INTEGER NOT NULL,
      nome              TEXT NOT NULL,
      precoAdicional    REAL NOT NULL DEFAULT 0,
      insumoProdutoId   INTEGER,
      quantidadeInsumo  REAL,
      ordem             INTEGER NOT NULL DEFAULT 0,
      ativo             INTEGER NOT NULL DEFAULT 1,
      FOREIGN KEY (grupoId)         REFERENCES rest_grupos_opcao(id) ON DELETE CASCADE,
      FOREIGN KEY (insumoProdutoId) REFERENCES produtos(id)
    );
    CREATE INDEX IF NOT EXISTS idx_rest_opcoes_grupo ON rest_opcoes(grupoId);

    CREATE TABLE IF NOT EXISTS rest_produto_grupos (
      produtoId  INTEGER NOT NULL,
      grupoId    INTEGER NOT NULL,
      ordem      INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (produtoId, grupoId),
      FOREIGN KEY (produtoId) REFERENCES produtos(id) ON DELETE CASCADE,
      FOREIGN KEY (grupoId)   REFERENCES rest_grupos_opcao(id) ON DELETE CASCADE
    );

    -- Satélite de produtos: mantém a tabela core limpa (ela é compartilhada
    -- com licitações e varejo).
    -- tipoItem: preparado | revenda | servico
    CREATE TABLE IF NOT EXISTS rest_produto_config (
      produtoId       INTEGER PRIMARY KEY,
      setorId         INTEGER,
      tempoPreparoMin INTEGER NOT NULL DEFAULT 0,
      tipoItem        TEXT NOT NULL DEFAULT 'preparado',
      imprimeCozinha  INTEGER NOT NULL DEFAULT 1,
      pesavel         INTEGER NOT NULL DEFAULT 0,
      precoPorKg      REAL,
      FOREIGN KEY (produtoId) REFERENCES produtos(id) ON DELETE CASCADE,
      FOREIGN KEY (setorId)   REFERENCES rest_setores(id)
    );
  `);

  // ==================== FICHA TÉCNICA / CMV ====================

  execSafe(db, `
    -- Ficha própria por produto. Sub-receita não precisa de tabela: o insumo é
    -- um produto, e se esse produto tiver ficha, a explosão desce nele
    -- (com guarda de profundidade contra ciclo).
    CREATE TABLE IF NOT EXISTS rest_fichas (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      produtoId         INTEGER NOT NULL UNIQUE,
      rendimento        REAL NOT NULL DEFAULT 1,
      unidadeRendimento TEXT NOT NULL DEFAULT 'UN',
      modoPreparo       TEXT,
      ativo             INTEGER NOT NULL DEFAULT 1,
      FOREIGN KEY (produtoId) REFERENCES produtos(id) ON DELETE CASCADE
    );

    -- quantidadeBruta é o peso de compra. O consumo real é
    --   bruta * fatorCorrecao (perda de limpeza) e o rendimento após cocção
    -- é ajustado por fatorCoccao. Guardar os dois separados é o que permite
    -- comparar CMV teórico com CMV real.
    CREATE TABLE IF NOT EXISTS rest_ficha_itens (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      fichaId          INTEGER NOT NULL,
      insumoProdutoId  INTEGER NOT NULL,
      quantidadeBruta  REAL NOT NULL,
      unidade          TEXT NOT NULL DEFAULT 'KG',
      fatorCorrecao    REAL NOT NULL DEFAULT 1,
      fatorCoccao      REAL NOT NULL DEFAULT 1,
      ordem            INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (fichaId)         REFERENCES rest_fichas(id) ON DELETE CASCADE,
      FOREIGN KEY (insumoProdutoId) REFERENCES produtos(id)
    );
    CREATE INDEX IF NOT EXISTS idx_rest_ficha_itens_ficha ON rest_ficha_itens(fichaId);

    -- Produção em lote (molho que abastece a semana).
    CREATE TABLE IF NOT EXISTS rest_producoes (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      produtoId   INTEGER NOT NULL,
      quantidade  REAL NOT NULL,
      custoTotal  REAL,
      data        TEXT NOT NULL,
      usuario     TEXT,
      observacao  TEXT,
      FOREIGN KEY (produtoId) REFERENCES produtos(id)
    );
    CREATE INDEX IF NOT EXISTS idx_rest_producoes_prod ON rest_producoes(produtoId);
  `);

  // ==================== COMANDA (as cinco operações) ====================

  execSafe(db, `
    -- tipo:   mesa | individual | balcao | delivery
    -- status: aberta | fechada | cancelada
    -- versao: incrementa a cada mudança; é o que o KDS e o salão usam para
    --         saber que precisam redesenhar sem baixar a comanda inteira.
    CREATE TABLE IF NOT EXISTS rest_comandas (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      tipo             TEXT NOT NULL DEFAULT 'mesa',
      mesaId           INTEGER,
      codigo           TEXT,
      numeroPessoas    INTEGER NOT NULL DEFAULT 1,
      garcomUserId     INTEGER,
      clienteId        INTEGER,
      canal            TEXT NOT NULL DEFAULT 'salao',
      status           TEXT NOT NULL DEFAULT 'aberta',
      senhaChamada     TEXT,
      turnoId          INTEGER,
      abertaEm         TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      fechadaEm        TEXT,
      observacao       TEXT,
      totalItens       REAL NOT NULL DEFAULT 0,
      totalTaxaServico REAL NOT NULL DEFAULT 0,
      totalCouvert     REAL NOT NULL DEFAULT 0,
      totalDesconto    REAL NOT NULL DEFAULT 0,
      totalGeral       REAL NOT NULL DEFAULT 0,
      totalPago        REAL NOT NULL DEFAULT 0,
      taxaServicoPct   REAL,
      canalExterno     TEXT,
      pedidoExternoId  TEXT,
      versao           INTEGER NOT NULL DEFAULT 1,
      FOREIGN KEY (mesaId) REFERENCES rest_mesas(id)
    );
    CREATE INDEX IF NOT EXISTS idx_rest_comandas_status ON rest_comandas(status);
    CREATE INDEX IF NOT EXISTS idx_rest_comandas_mesa   ON rest_comandas(mesaId);
    CREATE INDEX IF NOT EXISTS idx_rest_comandas_turno  ON rest_comandas(turnoId);

    -- itemPaiId: meio-a-meio de pizza e itens acompanhantes penduram no pai.
    -- status: pendente | em-preparo | pronto | entregue | cancelado
    CREATE TABLE IF NOT EXISTS rest_comanda_itens (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      comandaId        INTEGER NOT NULL,
      produtoId        INTEGER,
      descricao        TEXT NOT NULL,
      quantidade       REAL NOT NULL DEFAULT 1,
      precoUnit        REAL NOT NULL DEFAULT 0,
      precoTotal       REAL NOT NULL DEFAULT 0,
      observacao       TEXT,
      status           TEXT NOT NULL DEFAULT 'pendente',
      setorId          INTEGER,
      garcomUserId     INTEGER,
      itemPaiId        INTEGER,
      pesoKg           REAL,
      lancadoEm        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      preparoEm        TEXT,
      prontoEm         TEXT,
      entregueEm       TEXT,
      canceladoEm      TEXT,
      canceladoMotivo  TEXT,
      FOREIGN KEY (comandaId) REFERENCES rest_comandas(id) ON DELETE CASCADE,
      FOREIGN KEY (produtoId) REFERENCES produtos(id),
      FOREIGN KEY (setorId)   REFERENCES rest_setores(id)
    );
    CREATE INDEX IF NOT EXISTS idx_rest_com_itens_comanda ON rest_comanda_itens(comandaId);
    CREATE INDEX IF NOT EXISTS idx_rest_com_itens_status  ON rest_comanda_itens(status, setorId);

    -- Snapshot do nome e do preço: a opção pode ser renomeada ou ter preço
    -- alterado depois; a comanda tem de continuar contando a mesma história.
    CREATE TABLE IF NOT EXISTS rest_comanda_item_opcoes (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      comandaItemId  INTEGER NOT NULL,
      opcaoId        INTEGER,
      nome           TEXT NOT NULL,
      precoAdicional REAL NOT NULL DEFAULT 0,
      FOREIGN KEY (comandaItemId) REFERENCES rest_comanda_itens(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_rest_com_item_opc ON rest_comanda_item_opcoes(comandaItemId);

    -- Divisão de conta e fechamento parcial: N pagamentos por comanda.
    -- turnoId é carimbado no ato do pagamento. A alternativa — apurar o turno
    -- por janela de tempo — é ambígua: os timestamps têm precisão de segundo,
    -- e um pagamento no mesmo segundo da virada de turno cairia nos dois.
    CREATE TABLE IF NOT EXISTS rest_comanda_pagamentos (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      comandaId      INTEGER NOT NULL,
      meioPagamento  TEXT NOT NULL,
      valor          REAL NOT NULL,
      nomePagador    TEXT,
      nfceId         INTEGER,
      turnoId        INTEGER,
      usuario        TEXT,
      criadoEm       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (comandaId) REFERENCES rest_comandas(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_rest_com_pag ON rest_comanda_pagamentos(comandaId);
    CREATE INDEX IF NOT EXISTS idx_rest_com_pag_turno ON rest_comanda_pagamentos(turnoId);

    -- Trilha: abertura, transferência, junção, cancelamento de item lançado.
    -- Cancelar item já enviado à cozinha é o ponto mais sensível da operação
    -- (é onde furo de caixa aparece) — por isso tem evento próprio.
    CREATE TABLE IF NOT EXISTS rest_comanda_eventos (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      comandaId  INTEGER NOT NULL,
      tipo       TEXT NOT NULL,
      descricao  TEXT,
      usuario    TEXT,
      criadoEm   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (comandaId) REFERENCES rest_comandas(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_rest_com_ev ON rest_comanda_eventos(comandaId);
  `);

  // ==================== CAIXA: TURNO, SANGRIA, SUPRIMENTO ====================

  execSafe(db, `
    -- Não existia nada de turno/sangria no sistema antes deste módulo.
    -- status: aberto | fechado
    CREATE TABLE IF NOT EXISTS rest_turnos (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      operadorUserId  INTEGER,
      operadorNome    TEXT,
      abertoEm        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      fechadoEm       TEXT,
      valorAbertura   REAL NOT NULL DEFAULT 0,
      valorApurado    REAL,
      valorInformado  REAL,
      diferenca       REAL,
      status          TEXT NOT NULL DEFAULT 'aberto',
      observacao      TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_rest_turnos_status ON rest_turnos(status);

    -- tipo: sangria | suprimento
    CREATE TABLE IF NOT EXISTS rest_turno_movimentos (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      turnoId   INTEGER NOT NULL,
      tipo      TEXT NOT NULL,
      valor     REAL NOT NULL,
      motivo    TEXT,
      usuario   TEXT,
      criadoEm  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (turnoId) REFERENCES rest_turnos(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_rest_turno_mov ON rest_turno_movimentos(turnoId);
  `);

  // ==================== DELIVERY ====================

  execSafe(db, `
    CREATE TABLE IF NOT EXISTS rest_bairros_taxa (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      nome             TEXT NOT NULL,
      taxa             REAL NOT NULL DEFAULT 0,
      tempoEstimadoMin INTEGER NOT NULL DEFAULT 30,
      ativo            INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS rest_entregadores (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      nome      TEXT NOT NULL,
      pessoaId  INTEGER,
      telefone  TEXT,
      ativo     INTEGER NOT NULL DEFAULT 1
    );

    -- status: pendente | em-rota | entregue | cancelada
    CREATE TABLE IF NOT EXISTS rest_entregas (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      comandaId     INTEGER NOT NULL,
      entregadorId  INTEGER,
      bairroId      INTEGER,
      endereco      TEXT,
      numero        TEXT,
      complemento   TEXT,
      referencia    TEXT,
      taxa          REAL NOT NULL DEFAULT 0,
      status        TEXT NOT NULL DEFAULT 'pendente',
      saiuEm        TEXT,
      entregueEm    TEXT,
      FOREIGN KEY (comandaId)    REFERENCES rest_comandas(id) ON DELETE CASCADE,
      FOREIGN KEY (entregadorId) REFERENCES rest_entregadores(id),
      FOREIGN KEY (bairroId)     REFERENCES rest_bairros_taxa(id)
    );
    CREATE INDEX IF NOT EXISTS idx_rest_entregas_comanda ON rest_entregas(comandaId);
    CREATE INDEX IF NOT EXISTS idx_rest_entregas_status  ON rest_entregas(status);
  `);

  // ==================== CANAIS EXTERNOS (iFood etc.) ====================

  execSafe(db, `
    CREATE TABLE IF NOT EXISTS rest_canais_integracao (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      canal           TEXT NOT NULL UNIQUE,
      merchantId      TEXT,
      clientId        TEXT,
      clientSecret    TEXT,
      accessToken     TEXT,
      tokenExpiraEm   INTEGER,
      ativo           INTEGER NOT NULL DEFAULT 0,
      ultimoPollingEm TEXT,
      ultimoErro      TEXT,
      -- Aponta para o sandbox do parceiro durante a homologação; vazio = produção.
      baseUrl         TEXT
    );

    -- eventoId UNIQUE é a idempotência do polling: o iFood reentrega evento
    -- que não recebeu ACK, e sem isso o mesmo pedido viraria duas comandas.
    CREATE TABLE IF NOT EXISTS rest_canal_eventos (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      canal            TEXT NOT NULL,
      eventoId         TEXT NOT NULL,
      tipo             TEXT,
      pedidoExternoId  TEXT,
      payload          TEXT,
      comandaId        INTEGER,
      recebidoEm       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      processadoEm     TEXT,
      erro             TEXT,
      UNIQUE (canal, eventoId)
    );
    CREATE INDEX IF NOT EXISTS idx_rest_canal_ev_ped ON rest_canal_eventos(canal, pedidoExternoId);
  `);

  // ==================== GORJETA (Lei 13.419/2017) ====================

  execSafe(db, `
    -- status: aberto | fechado | pago
    CREATE TABLE IF NOT EXISTS rest_gorjeta_rateio (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      periodoIni       TEXT NOT NULL,
      periodoFim       TEXT NOT NULL,
      funcionarioId    INTEGER,
      funcionarioNome  TEXT,
      valorBruto       REAL NOT NULL DEFAULT 0,
      retencaoEncargos REAL NOT NULL DEFAULT 0,
      valorLiquido     REAL NOT NULL DEFAULT 0,
      criterio         TEXT,
      status           TEXT NOT NULL DEFAULT 'aberto',
      criadoEm         TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_rest_gorjeta_periodo ON rest_gorjeta_rateio(periodoIni, periodoFim);
  `);

  // ALTERs idempotentes — para tenants que já receberam uma versão anterior
  // deste schema antes de alguma coluna existir.
  alterSafe(db, 'ALTER TABLE rest_comandas ADD COLUMN totalPago REAL NOT NULL DEFAULT 0');
  alterSafe(db, 'ALTER TABLE rest_comandas ADD COLUMN taxaServicoPct REAL');
  alterSafe(db, 'ALTER TABLE rest_comandas ADD COLUMN turnoId INTEGER');
  alterSafe(db, 'ALTER TABLE rest_comanda_itens ADD COLUMN pesoKg REAL');
  alterSafe(db, 'ALTER TABLE rest_comanda_pagamentos ADD COLUMN turnoId INTEGER');
  alterSafe(db, 'ALTER TABLE rest_canais_integracao ADD COLUMN baseUrl TEXT');

  seedSetores(db);
}

// Setores mínimos para o KDS não nascer vazio. Só insere se a tabela estiver
// zerada — nunca revisita escolha do usuário.
function seedSetores(db) {
  try {
    const n = db.prepare('SELECT COUNT(*) AS n FROM rest_setores').get();
    if (n && n.n > 0) return;
    const ins = db.prepare('INSERT INTO rest_setores (codigo, nome, ordem) VALUES (?, ?, ?)');
    const tx = db.transaction(() => {
      ins.run('cozinha',    'Cozinha',    1);
      ins.run('chapa',      'Chapa/Grill', 2);
      ins.run('bar',        'Bar',        3);
      ins.run('sobremesa',  'Sobremesa',  4);
      ins.run('expedicao',  'Expedição',  5);
    });
    tx();
  } catch (_) { /* banco sem a tabela ainda (boot stub) — no-op */ }
}

module.exports = { initRestauranteSchema, seedSetores };
