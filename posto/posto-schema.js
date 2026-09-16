/**
 * posto-schema.js — Módulo Posto de Combustível, fase 1: fundação.
 *
 * Modelo em três camadas, na ordem em que o dado nasce no posto:
 *
 *   CADASTRO   posto_combustiveis → posto_tanques → posto_bombas → posto_bicos
 *              (o bico é o cruzamento: pertence a UMA bomba e puxa de UM tanque)
 *
 *   MOVIMENTO  posto_turnos ─┬─ posto_abastecimentos (saída, por bico)
 *                            └─ posto_turno_bicos    (encerrante de abertura/fecho)
 *              posto_descargas   (entrada, por tanque)
 *              posto_afericoes   (saída que volta ao tanque — INMETRO, 20 L)
 *              posto_medicoes    (estoque físico do tanque: régua ou sonda)
 *
 *   APURAÇÃO   posto_lmc_dias  (um dia × um produto = uma linha do LMC)
 *              posto_lmc_tanques (o mesmo dia aberto por tanque, para achar
 *                                 QUAL tanque explica a diferença)
 *
 * Por que o estoque de combustível não usa as tabelas de estoque do core:
 * ele não é contado, é MEDIDO — e as duas medidas (física e contábil) divergem
 * todo dia por evaporação, temperatura e erro de bomba. A ANP tolera até 0,6%
 * (Resolução ANP 884/2022) e exige que o posto apure a diferença. Um saldo
 * único de `estoque_saldos` não tem onde guardar essa divergência.
 *
 * Feature flag por-tenant em config('posto_enabled') — mesmo contrato dos
 * módulos Ótica e Restaurante.
 */

function alterSafe(db, sql) { try { db.exec(sql); } catch { /* coluna/tabela já existe */ } }

function initPostoSchema(db) {
  db.exec(`
    -- ═══════════════════ CADASTRO ═══════════════════

    -- Produto ANP. O código (cProdANP) é o que a NFC-e exige no grupo <comb>;
    -- fica cadastrado desde já para a fase fiscal não ter de reabrir a tabela.
    CREATE TABLE IF NOT EXISTS posto_combustiveis (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      codigo TEXT NOT NULL UNIQUE,        -- interno: 'GC', 'GA', 'ET', 'S10', 'S500'
      nome TEXT NOT NULL,
      cProdANP TEXT,                      -- código ANP (NFC-e/NF-e grupo comb)
      descANP TEXT,
      unidade TEXT NOT NULL DEFAULT 'L',  -- 'L' | 'KG' (GLP é por kg)
      produtoId INTEGER,                  -- vínculo opcional com o catálogo do core
      precoLitro REAL DEFAULT 0,          -- preço vigente na bomba
      ativo INTEGER NOT NULL DEFAULT 1,
      criadoEm TEXT DEFAULT CURRENT_TIMESTAMP
    );

    -- Histórico de preço: o posto muda preço no meio do dia e o fechamento
    -- precisa saber qual preço valia em cada abastecimento.
    CREATE TABLE IF NOT EXISTS posto_precos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      combustivelId INTEGER NOT NULL,
      precoLitro REAL NOT NULL,
      vigenciaInicio TEXT NOT NULL,       -- 'YYYY-MM-DD HH:MM:SS'
      usuario TEXT,
      criadoEm TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (combustivelId) REFERENCES posto_combustiveis(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_posto_precos_comb
      ON posto_precos(combustivelId, vigenciaInicio DESC);

    CREATE TABLE IF NOT EXISTS posto_tanques (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      codigo TEXT NOT NULL UNIQUE,        -- 'T1', 'T2' — é o nTanque da NFC-e
      combustivelId INTEGER NOT NULL,
      capacidadeLitros REAL NOT NULL,
      -- Estoque de segurança: abaixo disto o tanque entra em alerta de pane seca.
      estoqueMinimoLitros REAL DEFAULT 0,
      ativo INTEGER NOT NULL DEFAULT 1,
      observacao TEXT,
      criadoEm TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (combustivelId) REFERENCES posto_combustiveis(id)
    );

    CREATE TABLE IF NOT EXISTS posto_bombas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      codigo TEXT NOT NULL UNIQUE,        -- 'B1' — é o nBomba da NFC-e
      fabricante TEXT,
      modelo TEXT,
      numeroSerie TEXT,
      ativo INTEGER NOT NULL DEFAULT 1,
      criadoEm TEXT DEFAULT CURRENT_TIMESTAMP
    );

    -- Lacre da bomba: o SPED (registro 1360) pede número e datas. Linha nova a
    -- cada aplicação; a remoção fecha a anterior em vez de apagá-la, porque
    -- lacre rompido é justamente o que o fisco quer ver no histórico.
    CREATE TABLE IF NOT EXISTS posto_lacres (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bombaId INTEGER NOT NULL,
      numero TEXT NOT NULL,
      dataAplicacao TEXT NOT NULL,        -- 'YYYY-MM-DD'
      dataRemocao TEXT,                   -- NULL = lacre vigente
      motivoRemocao TEXT,
      criadoEm TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (bombaId) REFERENCES posto_bombas(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_posto_lacres_bomba ON posto_lacres(bombaId, dataRemocao);

    CREATE TABLE IF NOT EXISTS posto_bicos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      numero TEXT NOT NULL UNIQUE,        -- é o nBico da NFC-e
      bombaId INTEGER NOT NULL,
      tanqueId INTEGER NOT NULL,
      -- Encerrante corrente: espelho do totalizador mecânico/eletrônico do bico.
      -- É a fonte da venda (litros vendidos = encerrante final − inicial), por
      -- isso nunca é editado direto: quem o move é o movimento registrado.
      encerranteAtual REAL NOT NULL DEFAULT 0,
      ativo INTEGER NOT NULL DEFAULT 1,
      criadoEm TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (bombaId) REFERENCES posto_bombas(id),
      FOREIGN KEY (tanqueId) REFERENCES posto_tanques(id)
    );
    CREATE INDEX IF NOT EXISTS idx_posto_bicos_bomba ON posto_bicos(bombaId);
    CREATE INDEX IF NOT EXISTS idx_posto_bicos_tanque ON posto_bicos(tanqueId);

    -- ═══════════════════ MOVIMENTO ═══════════════════

    CREATE TABLE IF NOT EXISTS posto_turnos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      frentistaNome TEXT NOT NULL,
      funcionarioId INTEGER,              -- vínculo opcional com rh_funcionarios
      abertoEm TEXT NOT NULL,
      fechadoEm TEXT,
      status TEXT NOT NULL DEFAULT 'aberto',   -- aberto | fechado
      -- Fechamento financeiro: o que o sistema calculou × o que o frentista
      -- entregou. A diferença é a quebra de caixa do turno.
      valorApurado REAL DEFAULT 0,
      valorEntregue REAL DEFAULT 0,
      diferencaCaixa REAL DEFAULT 0,
      observacao TEXT,
      criadoEm TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_posto_turnos_status ON posto_turnos(status, abertoEm DESC);

    -- Encerrante de cada bico na abertura e no fechamento do turno. É o
    -- contraditório do abastecimento: se a soma dos abastecimentos do turno não
    -- bate com (fim − início), houve venda não registrada.
    CREATE TABLE IF NOT EXISTS posto_turno_bicos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      turnoId INTEGER NOT NULL,
      bicoId INTEGER NOT NULL,
      encerranteInicio REAL NOT NULL,
      encerranteFim REAL,
      litrosApurados REAL,                -- fim − início
      litrosRegistrados REAL,             -- soma dos abastecimentos lançados
      divergenciaLitros REAL,
      UNIQUE(turnoId, bicoId),
      FOREIGN KEY (turnoId) REFERENCES posto_turnos(id) ON DELETE CASCADE,
      FOREIGN KEY (bicoId) REFERENCES posto_bicos(id)
    );

    -- Saída de combustível pelo bico.
    --   tipo 'venda'    → sai do estoque e entra no faturamento
    --   tipo 'afericao' → sai e VOLTA ao tanque (não é venda; ver posto_afericoes)
    --   tipo 'interno'  → consumo próprio (gerador, frota do posto)
    -- origem 'manual' hoje; 'concentrador' quando a fase 3 ligar o hardware.
    CREATE TABLE IF NOT EXISTS posto_abastecimentos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      turnoId INTEGER,
      bicoId INTEGER NOT NULL,
      dataHora TEXT NOT NULL,
      litros REAL NOT NULL,
      precoLitro REAL NOT NULL DEFAULT 0,
      valorTotal REAL NOT NULL DEFAULT 0,
      encerranteInicio REAL,
      encerranteFim REAL,
      tipo TEXT NOT NULL DEFAULT 'venda',
      origem TEXT NOT NULL DEFAULT 'manual',
      pessoaId INTEGER,                   -- cliente identificado (convênio/frota)
      placa TEXT,
      odometro INTEGER,
      documento TEXT,                     -- nº do cupom/NFC-e quando houver
      observacao TEXT,
      criadoEm TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (turnoId) REFERENCES posto_turnos(id),
      FOREIGN KEY (bicoId) REFERENCES posto_bicos(id)
    );
    CREATE INDEX IF NOT EXISTS idx_posto_abast_turno ON posto_abastecimentos(turnoId);
    CREATE INDEX IF NOT EXISTS idx_posto_abast_data ON posto_abastecimentos(dataHora);
    CREATE INDEX IF NOT EXISTS idx_posto_abast_bico ON posto_abastecimentos(bicoId, dataHora);

    -- Entrada: descarga do caminhão-tanque.
    -- litrosNota × litrosRecebidos (medido) é a conferência que pega falta de
    -- carga; o volume a 20 °C existe porque combustível dilata — o mesmo produto
    -- rende volumes diferentes a 25 °C e a 20 °C, e a NF vem em um dos dois.
    CREATE TABLE IF NOT EXISTS posto_descargas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tanqueId INTEGER NOT NULL,
      dataHora TEXT NOT NULL,
      notaFiscal TEXT,
      fornecedorId INTEGER,               -- pessoas(id) — distribuidora
      litrosNota REAL NOT NULL DEFAULT 0,
      medicaoAntesLitros REAL,
      medicaoDepoisLitros REAL,
      litrosRecebidos REAL NOT NULL DEFAULT 0,   -- depois − antes
      temperaturaC REAL,
      litros20C REAL,
      diferencaLitros REAL,               -- recebidos − nota
      lacreConferido INTEGER DEFAULT 0,
      amostraTestemunha INTEGER DEFAULT 0,       -- Resolução ANP 898/2022
      responsavel TEXT,
      observacao TEXT,
      criadoEm TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (tanqueId) REFERENCES posto_tanques(id)
    );
    CREATE INDEX IF NOT EXISTS idx_posto_descargas_data ON posto_descargas(dataHora);
    CREATE INDEX IF NOT EXISTS idx_posto_descargas_tanque ON posto_descargas(tanqueId, dataHora);

    -- Aferição INMETRO: 20 L pelo bico, conferidos no aferidor e devolvidos ao
    -- tanque. Move o encerrante mas NÃO é venda — se não for registrada, vira
    -- falta de estoque no LMC. Tolerância da Portaria INMETRO 227/2022:
    -- entre −60 ml e +100 ml em 20 L.
    CREATE TABLE IF NOT EXISTS posto_afericoes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bicoId INTEGER NOT NULL,
      dataHora TEXT NOT NULL,
      volumePadraoMl REAL NOT NULL DEFAULT 20000,
      volumeMedidoMl REAL NOT NULL,
      desvioMl REAL,                      -- medido − padrão
      aprovado INTEGER,
      encerranteInicio REAL,
      encerranteFim REAL,
      retornouAoTanque INTEGER NOT NULL DEFAULT 1,
      responsavel TEXT,
      observacao TEXT,
      criadoEm TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (bicoId) REFERENCES posto_bicos(id)
    );
    CREATE INDEX IF NOT EXISTS idx_posto_afericoes_data ON posto_afericoes(dataHora);

    -- Estoque FÍSICO do tanque. origem 'sonda' quando a fase 3 ligar o ATG;
    -- 'manual' é a régua (proibida pela NR-20 onde há viabilidade técnica de
    -- sonda, mas ainda é o que a maioria dos postos tem hoje).
    CREATE TABLE IF NOT EXISTS posto_medicoes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tanqueId INTEGER NOT NULL,
      dataHora TEXT NOT NULL,
      data TEXT NOT NULL,                 -- 'YYYY-MM-DD', para casar com o LMC
      tipo TEXT NOT NULL DEFAULT 'fechamento',  -- abertura | fechamento | avulsa
      litrosFisico REAL NOT NULL,
      alturaCm REAL,
      aguaCm REAL,
      temperaturaC REAL,
      origem TEXT NOT NULL DEFAULT 'manual',
      responsavel TEXT,
      observacao TEXT,
      criadoEm TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (tanqueId) REFERENCES posto_tanques(id)
    );
    CREATE INDEX IF NOT EXISTS idx_posto_medicoes_tanque ON posto_medicoes(tanqueId, data DESC);

    -- ═══════════════════ APURAÇÃO (LMC) ═══════════════════

    -- Uma linha por dia × produto — é o formato que a ANP pede no LMC, e o
    -- registro 1300 do SPED tem a mesma granularidade. O detalhe por tanque
    -- fica na tabela irmã: o LMC é por produto, mas quem tem perda é o tanque.
    CREATE TABLE IF NOT EXISTS posto_lmc_dias (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      data TEXT NOT NULL,
      combustivelId INTEGER NOT NULL,
      estoqueAberturaL REAL NOT NULL DEFAULT 0,
      entradasL REAL NOT NULL DEFAULT 0,        -- descargas
      vendasL REAL NOT NULL DEFAULT 0,          -- abastecimentos tipo venda
      afericoesL REAL NOT NULL DEFAULT 0,       -- saem e voltam: neutras no saldo
      consumoInternoL REAL NOT NULL DEFAULT 0,
      estoqueContabilL REAL NOT NULL DEFAULT 0, -- abertura + entradas − saídas
      estoqueFisicoL REAL,                      -- medição do dia (soma dos tanques)
      perdaGanhoL REAL,                         -- físico − contábil
      perdaGanhoPct REAL,                       -- sobre a movimentação do dia
      dentroTolerancia INTEGER,                 -- |pct| <= 0,6
      status TEXT NOT NULL DEFAULT 'aberto',    -- aberto | fechado
      fechadoEm TEXT,
      fechadoPor TEXT,
      observacao TEXT,
      UNIQUE(data, combustivelId),
      FOREIGN KEY (combustivelId) REFERENCES posto_combustiveis(id)
    );
    CREATE INDEX IF NOT EXISTS idx_posto_lmc_data ON posto_lmc_dias(data DESC);

    CREATE TABLE IF NOT EXISTS posto_lmc_tanques (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lmcDiaId INTEGER NOT NULL,
      tanqueId INTEGER NOT NULL,
      estoqueAberturaL REAL NOT NULL DEFAULT 0,
      entradasL REAL NOT NULL DEFAULT 0,
      saidasL REAL NOT NULL DEFAULT 0,
      estoqueContabilL REAL NOT NULL DEFAULT 0,
      estoqueFisicoL REAL,
      perdaGanhoL REAL,
      perdaGanhoPct REAL,
      UNIQUE(lmcDiaId, tanqueId),
      FOREIGN KEY (lmcDiaId) REFERENCES posto_lmc_dias(id) ON DELETE CASCADE,
      FOREIGN KEY (tanqueId) REFERENCES posto_tanques(id)
    );
  `);

  // Semeia os produtos ANP mais comuns na revenda. Códigos cProdANP conforme a
  // tabela de produtos da ANP usada pela NF-e. Só entra em base vazia — não
  // sobrescreve o que o posto tiver cadastrado.
  const temComb = db.prepare('SELECT COUNT(*) AS n FROM posto_combustiveis').get();
  if (!temComb || temComb.n === 0) {
    const ins = db.prepare(`
      INSERT INTO posto_combustiveis (codigo, nome, cProdANP, descANP, unidade)
      VALUES (?, ?, ?, ?, 'L')
    `);
    db.transaction(() => {
      ins.run('GC',   'Gasolina Comum',    '320102001', 'GASOLINA C COMUM');
      ins.run('GA',   'Gasolina Aditivada','320102002', 'GASOLINA C ADITIVADA');
      ins.run('ET',   'Etanol Hidratado',  '810101001', 'ETANOL HIDRATADO COMBUSTIVEL');
      ins.run('S10',  'Diesel S10',        '820101034', 'OLEO DIESEL B S10 COMUM');
      ins.run('S500', 'Diesel S500',       '820101032', 'OLEO DIESEL B S500 COMUM');
    })();
  }

  // Colunas acrescentadas depois do primeiro CREATE: tenants que já rodaram a
  // versão anterior do schema não as têm.
  alterSafe(db, 'ALTER TABLE posto_turnos ADD COLUMN caixaAberturaValor REAL DEFAULT 0');

  // Aferição passa a saber a que turno pertence. Antes o fechamento a somava
  // por janela de horário (abertoEm..fechadoEm) e um turno com abertura
  // retroativa contava de novo a aferição de um turno já fechado — inventando
  // litros registrados que ninguém lançou ali.
  alterSafe(db, 'ALTER TABLE posto_afericoes ADD COLUMN turnoId INTEGER');
  alterSafe(db, 'CREATE INDEX IF NOT EXISTS idx_posto_afericoes_turno ON posto_afericoes(turnoId)');
}

module.exports = { initPostoSchema };
