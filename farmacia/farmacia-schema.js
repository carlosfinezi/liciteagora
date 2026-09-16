/**
 * farmacia-schema.js — Schema do módulo Farmácia (vertical: drogaria).
 *
 * Modelo: NÃO altera tabelas core. O item vendável continua sendo `produtos`
 * (herda NCM/CFOP/CST, motor de tributação, lote/estoque e NFC-e de graça);
 * tudo que é específico do segmento mora em tabelas `farmacia_*` que
 * referenciam `produtos` por FK.
 *
 *   produtos (core)
 *     └── farmacia_medicamento_specs  (1:1 — registro ANVISA, tarja, PMC, lista CMED)
 *
 *   lotes (core, já existente)   ← o rastro do XML e o SNGPC saem daqui
 *   movimentacoes_estoque.loteId (core, já existente)
 *
 * IMPORTANTE — por que este arquivo é chamado pelo db-schema.js:
 * o migrarDB() de um *-routes.js roda dentro do runInBootContext contra o
 * BOOT_STUB e é no-op em multi-tenant; não alcança nenhum dos tenants
 * existentes. Quem aplica schema em tenant existente é o db-schema.js.
 * Este módulo é chamado de lá (padrão do fiscal-trib-schema/restaurante).
 *
 * Todo o schema das fases 0..6 é criado de uma vez, de propósito: tabela vazia
 * não custa nada e evita um restart de produção por fase.
 *
 * A ÚNICA exceção à regra de não tocar core é `nfce_itens.loteId` (fase 2).
 * Justificativa: item de nota fiscal com lote é dado fiscal do documento, não
 * extensão de vertical — o grupo <rastro> do XML precisa reconstruir isso na
 * consulta, na reimpressão e no cancelamento. Coluna nullable, ignorada por
 * quem não é farmácia.
 */

// CREATE/ALTER tolerantes: o schema roda em todos os tenants, com históricos
// diferentes. Mesmo par de helpers do restaurante-schema.
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

function initFarmaciaSchema(db) {
  // ─── Fase 1: cadastro farmacêutico e lista CMED ────────────────────────────

  // Uma linha por lista de preços importada. Sem isto não dá para responder
  // "de que competência veio este PMC?", que é a primeira pergunta de qualquer
  // fiscalização de preço e do reajuste anual.
  execSafe(db, `
    CREATE TABLE IF NOT EXISTS farmacia_cmed_versoes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      competencia TEXT NOT NULL UNIQUE,
      arquivoNome TEXT,
      colunaPmc TEXT,
      ufReferencia TEXT,
      linhasLidas INTEGER DEFAULT 0,
      linhasCasadas INTEGER DEFAULT 0,
      linhasNaoCasadas INTEGER DEFAULT 0,
      importadoEm TEXT DEFAULT CURRENT_TIMESTAMP,
      importadoPor TEXT,
      observacoes TEXT
    )
  `);

  execSafe(db, `
    CREATE TABLE IF NOT EXISTS farmacia_medicamento_specs (
      produtoId INTEGER PRIMARY KEY,
      registroAnvisa TEXT,
      isentoRegistro INTEGER DEFAULT 0,
      motivoIsencao TEXT,
      ean TEXT,
      substancia TEXT,
      classeTerapeutica TEXT,
      laboratorio TEXT,
      cnpjLaboratorio TEXT,
      apresentacao TEXT,
      tarja TEXT,
      listaCmed TEXT,
      regimePreco TEXT DEFAULT 'regulado',
      pf REAL,
      pmc REAL,
      restricaoHospitalar INTEGER DEFAULT 0,
      listaPortaria344 TEXT,
      antimicrobiano INTEGER DEFAULT 0,
      tipoProduto TEXT,
      cmedVersaoId INTEGER,
      atualizadoEm TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (produtoId) REFERENCES produtos(id) ON DELETE CASCADE,
      FOREIGN KEY (cmedVersaoId) REFERENCES farmacia_cmed_versoes(id)
    )
  `);
  execSafe(db, 'CREATE INDEX IF NOT EXISTS idx_farm_specs_registro ON farmacia_medicamento_specs(registroAnvisa)');
  execSafe(db, 'CREATE INDEX IF NOT EXISTS idx_farm_specs_ean ON farmacia_medicamento_specs(ean)');
  execSafe(db, 'CREATE INDEX IF NOT EXISTS idx_farm_specs_substancia ON farmacia_medicamento_specs(substancia)');
  execSafe(db, 'CREATE INDEX IF NOT EXISTS idx_farm_specs_344 ON farmacia_medicamento_specs(listaPortaria344)');

  // De onde veio a tarja: 'cmed' (a lista informou), 'inferida' (deduzida de
  // outra linha da mesma substância, porque a CMED trouxe "- (*)"), 'manual'
  // (o farmacêutico corrigiu) ou 'desconhecida'. Sem isto não dá para saber o
  // que precisa de curadoria — e tarja errada é dispensação de controlado sem
  // receita. Ver farmacia/cmed-import.js.
  alterSafe(db, "ALTER TABLE farmacia_medicamento_specs ADD COLUMN tarjaOrigem TEXT");

  // Linha da CMED que não achou produto no catálogo. Fica registrada em vez de
  // virar produto novo às cegas: EAN da CMED é sabidamente sujo, e criar
  // produto a partir de EAN errado suja o catálogo de forma irreversível.
  execSafe(db, `
    CREATE TABLE IF NOT EXISTS farmacia_cmed_naocasados (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cmedVersaoId INTEGER NOT NULL,
      ean TEXT,
      produto TEXT,
      laboratorio TEXT,
      apresentacao TEXT,
      registroAnvisa TEXT,
      substancia TEXT,
      pmc REAL,
      motivo TEXT,
      FOREIGN KEY (cmedVersaoId) REFERENCES farmacia_cmed_versoes(id) ON DELETE CASCADE
    )
  `);
  execSafe(db, 'CREATE INDEX IF NOT EXISTS idx_farm_naocasados_versao ON farmacia_cmed_naocasados(cmedVersaoId)');

  // ─── Fase 2: lote na venda ─────────────────────────────────────────────────
  // Única exceção à regra de não tocar core — justificada no cabeçalho.
  alterSafe(db, 'ALTER TABLE nfce_itens ADD COLUMN loteId INTEGER');

  // ─── Fase 4: receita e Portaria 344/98 ─────────────────────────────────────

  // Os campos de prescritor/paciente/comprador não são zelo de cadastro: são
  // exatamente o que o SNGPC exige no XML de cada saída de controlado.
  execSafe(db, `
    CREATE TABLE IF NOT EXISTS farmacia_receitas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tipo TEXT NOT NULL,
      numero TEXT,
      dataEmissao TEXT NOT NULL,
      uf TEXT,
      prescritorNome TEXT,
      prescritorConselho TEXT,
      prescritorConselhoUf TEXT,
      prescritorNumero TEXT,
      pacienteNome TEXT,
      pacienteDocumento TEXT,
      pacienteEndereco TEXT,
      compradorNome TEXT,
      compradorDocumento TEXT,
      compradorEndereco TEXT,
      observacoes TEXT,
      criadoEm TEXT DEFAULT CURRENT_TIMESTAMP,
      criadoPor TEXT
    )
  `);
  execSafe(db, 'CREATE INDEX IF NOT EXISTS idx_farm_receitas_data ON farmacia_receitas(dataEmissao)');

  execSafe(db, `
    CREATE TABLE IF NOT EXISTS farmacia_receita_itens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      receitaId INTEGER NOT NULL,
      produtoId INTEGER,
      descricao TEXT,
      quantidade REAL NOT NULL DEFAULT 1,
      posologia TEXT,
      FOREIGN KEY (receitaId) REFERENCES farmacia_receitas(id) ON DELETE CASCADE
    )
  `);
  execSafe(db, 'CREATE INDEX IF NOT EXISTS idx_farm_receita_itens ON farmacia_receita_itens(receitaId)');

  execSafe(db, `
    CREATE TABLE IF NOT EXISTS farmacia_venda_receita (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      receitaId INTEGER NOT NULL,
      nfceId INTEGER,
      produtoId INTEGER,
      loteId INTEGER,
      quantidade REAL,
      criadoEm TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (receitaId) REFERENCES farmacia_receitas(id)
    )
  `);
  execSafe(db, 'CREATE INDEX IF NOT EXISTS idx_farm_venda_receita_nfce ON farmacia_venda_receita(nfceId)');

  // 'reservado' | 'confirmado'. A reserva existe para fechar uma corrida real:
  // entre conferir o saldo da receita e gravar o consumo há duas idas à SEFAZ
  // (assinatura e envio), e nesse intervalo o Node atende outra requisição.
  // Duas vendas simultâneas da mesma receita passavam as duas na conferência.
  // Agora o saldo é reservado numa transação síncrona ANTES dos awaits.
  alterSafe(db, "ALTER TABLE farmacia_venda_receita ADD COLUMN status TEXT DEFAULT 'confirmado'");
  execSafe(db, 'CREATE INDEX IF NOT EXISTS idx_farm_venda_receita_status ON farmacia_venda_receita(receitaId, produtoId, status)');

  // ─── Fase 5: SNGPC ─────────────────────────────────────────────────────────

  execSafe(db, `
    CREATE TABLE IF NOT EXISTS farmacia_sngpc_transmissoes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tipo TEXT NOT NULL,
      periodoInicio TEXT,
      periodoFim TEXT,
      ambiente TEXT DEFAULT 'homologacao',
      xml TEXT,
      md5 TEXT,
      status TEXT DEFAULT 'pendente',
      protocolo TEXT,
      critica TEXT,
      tentativas INTEGER DEFAULT 0,
      criadoEm TEXT DEFAULT CURRENT_TIMESTAMP,
      transmitidoEm TEXT
    )
  `);
  execSafe(db, 'CREATE INDEX IF NOT EXISTS idx_farm_sngpc_status ON farmacia_sngpc_transmissoes(status)');

  // Fila de eventos escrituráveis. Nasce no momento do fato (venda, entrada,
  // perda) e só depois é agrupada num XML — assim uma transmissão rejeitada
  // não perde o histórico nem obriga a recalcular a partir do estoque.
  execSafe(db, `
    CREATE TABLE IF NOT EXISTS farmacia_sngpc_eventos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      transmissaoId INTEGER,
      tipoMovimento TEXT NOT NULL,
      data TEXT NOT NULL,
      produtoId INTEGER,
      loteId INTEGER,
      quantidade REAL NOT NULL,
      receitaId INTEGER,
      documentoTipo TEXT,
      documentoNumero TEXT,
      origem TEXT,
      origemId INTEGER,
      status TEXT DEFAULT 'pendente',
      criadoEm TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (transmissaoId) REFERENCES farmacia_sngpc_transmissoes(id)
    )
  `);
  execSafe(db, 'CREATE INDEX IF NOT EXISTS idx_farm_sngpc_ev_status ON farmacia_sngpc_eventos(status, data)');
  execSafe(db, 'CREATE INDEX IF NOT EXISTS idx_farm_sngpc_ev_transm ON farmacia_sngpc_eventos(transmissaoId)');
}

module.exports = { initFarmaciaSchema, execSafe, alterSafe };
