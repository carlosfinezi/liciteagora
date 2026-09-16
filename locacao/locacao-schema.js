/**
 * locacao-schema.js — Schema do módulo Locação (vertical: locadora de bens móveis).
 *
 * Modelo: NÃO altera tabelas core. O item alugável continua sendo `produtos`
 * (herda NCM/CFOP/CST, motor de tributação, estoque e número de série de
 * graça); tudo que é específico do segmento mora em tabelas `locacao_*` que
 * referenciam `produtos` por FK.
 *
 *   produtos (core)
 *     ├── locacao_item_specs   (1:1 — alugável, caução, medidor, turnaround)
 *     └── locacao_tarifas      (1:N — hora/dia/semana/quinzena/mês)
 *
 *   serial_numbers (core)  ← a unidade física que sai e volta
 *   contratos      (core)  ← só no tipo `aberta`: renovação, reajuste, recorrência
 *   os_ordens      (core)  ← entrega e devolução com checklist/foto/assinatura
 *
 * IMPORTANTE — por que este arquivo é chamado pelo db-schema.js:
 * o migrarDB() de um *-routes.js roda dentro do runInBootContext contra o
 * BOOT_STUB e é no-op em multi-tenant; não alcança nenhum tenant existente.
 * Quem aplica schema em tenant existente é o db-schema.js. Este módulo é
 * chamado de lá (padrão do restaurante/farmácia/posto).
 *
 * Todo o schema das fases 1..6 é criado de uma vez, de propósito: tabela vazia
 * não custa nada e evita um restart de produção por fase.
 *
 * ─── DUAS VERDADES SOBRE DISPONIBILIDADE (leia antes de mexer) ───────────────
 * `reservas_estoque` (reservas-routes.js) reserva QUANTIDADE por pedido, sem
 * intervalo: `saldoReservado()` devolve um número, não uma agenda. Locação
 * precisa do oposto — a mesma máquina livre em setembro e ocupada em outubro.
 *
 * Não dá para acrescentar data lá: aquela função é consumida por pedidos
 * (pedidos-routes.js:999) e OS com a semântica de soma, e uma reserva com data
 * faria um pedido de venda ver como indisponível um item que só sai em
 * novembro.
 *
 * Por isso a reserva de locação vive em `locacao_reservas`, calculada por
 * SOBREPOSIÇÃO DE INTERVALO. Consequência: existem duas fontes de ocupação
 * para o mesmo produto. Quem for perguntar "posso alugar isto neste período?"
 * TEM de passar por `disponibilidade()` em locacao/disponibilidade.js, que
 * consulta as duas. Consultar só uma delas responde errado.
 *
 * ─── FORMATO DE DATA ────────────────────────────────────────────────────────
 * Todo instante de reserva/locação é TEXT no formato 'YYYY-MM-DD HH:MM:SS'
 * (o mesmo do CURRENT_TIMESTAMP do SQLite). A comparação de sobreposição é
 * lexicográfica, então o formato TEM de ser uniforme — normalize na entrada
 * com `normalizarInstante()` de locacao/tarifa.js. Data sem hora entra como
 * 00:00:00.
 */

// CREATE/ALTER tolerantes: o schema roda em todos os tenants, com históricos
// diferentes. Mesmo par de helpers do restaurante-schema/farmacia-schema.
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

/**
 * Índice tolerante. Existe porque `execSafe` só engolia "duplicate column" e
 * "already exists": um CREATE INDEX sobre coluna ausente (tabela criada por
 * uma versão anterior deste módulo) lançava `no such column` e, como o
 * db-schema.js chama sem try, DERRUBAVA O BOOT DO TENANT. O mesmo valia para
 * o UNIQUE de competência sobre dados que já tivessem duplicata.
 *
 * Índice que não pôde ser criado degrada desempenho ou deixa de garantir
 * unicidade — nunca justifica impedir o tenant de subir.
 */
function indexSafe(db, sql) {
  try {
    db.exec(sql);
  } catch (e) {
    if (/already exists/i.test(e.message)) return;
    if (/no such column/i.test(e.message) || /no such table/i.test(e.message)
        || /UNIQUE constraint failed/i.test(e.message) || /duplicate/i.test(e.message)) {
      console.warn('[locacao-schema] índice não criado:', e.message.trim(),
        '— o módulo segue funcionando; corrija os dados e reinicie para recriá-lo.');
      return;
    }
    throw e;
  }
}

/**
 * Acrescenta colunas que faltam numa tabela já existente.
 *
 * `CREATE TABLE IF NOT EXISTS` é no-op quando a tabela existe — então uma
 * tabela criada por versão anterior do módulo ficava sem as colunas novas e o
 * módulo dava 500 em runtime. Isto fecha essa lacuna de verdade, em vez de
 * confiar na sorte.
 */
function garantirColunas(db, tabela, colunas) {
  let existentes;
  try {
    existentes = db.prepare(`PRAGMA table_info(${tabela})`).all().map(c => c.name);
  } catch (_) {
    return; // tabela ainda não existe: o CREATE TABLE cuidou dela
  }
  if (!existentes.length) return;
  for (const [nome, definicao] of Object.entries(colunas)) {
    if (!existentes.includes(nome)) {
      alterSafe(db, `ALTER TABLE ${tabela} ADD COLUMN ${nome} ${definicao}`);
    }
  }
}

function initLocacaoSchema(db) {
  // ─── Fase 1: catálogo alugável e tarifário ─────────────────────────────────

  // 1:1 com `produtos`, espelhando optica_armacao_specs. Produto sem linha aqui
  // simplesmente não é alugável — não existe coluna nova em `produtos`.
  execSafe(db, `
    CREATE TABLE IF NOT EXISTS locacao_item_specs (
      produtoId INTEGER PRIMARY KEY,
      alugavel INTEGER NOT NULL DEFAULT 1,
      -- Quando 1, toda locação precisa apontar QUAL unidade saiu
      -- (serial_numbers). Máquina é 1; cadeira de festa, 0.
      exigeSerie INTEGER NOT NULL DEFAULT 0,
      -- NÃO existe categoria aqui, e é de propósito: a categoria do item
      -- alugável é a produtos.categoria do cadastro. Havia uma coluna
      -- própria, que criava duas verdades para a mesma pergunta — o operador
      -- classificava o produto no catálogo e tinha de classificar de novo
      -- aqui, com texto livre, sem nada garantindo que batessem.
      -- Caução e reposição aceitam valor fixo E percentual. O percentual tem
      -- precedência quando preenchido; o fixo vale sozinho ou como fallback
      -- de quando a base do percentual não existe (produto sem preço).
      caucaoPadrao REAL NOT NULL DEFAULT 0,
      caucaoPercentual REAL,
      -- Sobre o que incide o percentual da caução: 'locacao' (valor do
      -- aluguel) ou 'bem' (valor do equipamento). As duas leituras são
      -- correntes no mercado, então a escolha é do cadastro.
      caucaoPercentualBase TEXT DEFAULT 'locacao',
      -- Folga entre uma devolução e a próxima saída: limpeza, revisão,
      -- carga. Entra no cálculo de disponibilidade como extensão da reserva.
      horasPreparo REAL NOT NULL DEFAULT 0,
      -- nenhum | horimetro | km
      medidorTipo TEXT NOT NULL DEFAULT 'nenhum',
      -- Horas/km inclusos por diária. Acima disso cobra o extra da tarifa.
      franquiaPorDia REAL,
      -- Quanto cobrar se o bem não voltar. Sem isto, perda vira discussão.
      -- O percentual incide sempre sobre o valor do BEM (precoVenda, ou
      -- precoCusto quando não há venda) — repor % do aluguel não repõe nada.
      valorReposicao REAL,
      reposicaoPercentual REAL,
      observacoes TEXT,
      FOREIGN KEY (produtoId) REFERENCES produtos(id) ON DELETE CASCADE
    );
  `);

  // Uma linha por faixa de tempo. A progressividade é o ponto: 7 diárias têm
  // de virar 1 semana, senão o cliente faz a conta e a locadora perde.
  execSafe(db, `
    CREATE TABLE IF NOT EXISTS locacao_tarifas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      produtoId INTEGER NOT NULL,
      faixa TEXT NOT NULL,
      valor REAL NOT NULL,
      -- Mínimo faturável NA FAIXA: diária com minimo 1 cobra 1 dia inteiro
      -- para 3 horas de uso.
      minimoFaturavel REAL NOT NULL DEFAULT 1,
      ativo INTEGER NOT NULL DEFAULT 1,
      dataAtualizacao TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (produtoId) REFERENCES produtos(id) ON DELETE CASCADE,
      UNIQUE (produtoId, faixa)
    );
    CREATE INDEX IF NOT EXISTS idx_loc_tarifas_produto ON locacao_tarifas(produtoId, ativo);
  `);

  // Cobranças que não são tempo de uso. produtoId NULL = valor padrão do
  // tenant, usado por qualquer item que não tenha o seu.
  execSafe(db, `
    CREATE TABLE IF NOT EXISTS locacao_tarifa_extras (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      produtoId INTEGER,
      tipo TEXT NOT NULL,
      valor REAL NOT NULL,
      descricao TEXT,
      ativo INTEGER NOT NULL DEFAULT 1,
      FOREIGN KEY (produtoId) REFERENCES produtos(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_loc_extras ON locacao_tarifa_extras(tipo, ativo);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_loc_extras_global
      ON locacao_tarifa_extras(tipo) WHERE produtoId IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_loc_extras_produto
      ON locacao_tarifa_extras(produtoId, tipo) WHERE produtoId IS NOT NULL;
  `);

  // ─── Fase 2: disponibilidade por período ───────────────────────────────────

  // O coração do módulo. Ver o bloco "DUAS VERDADES" no topo antes de tocar.
  execSafe(db, `
    CREATE TABLE IF NOT EXISTS locacao_reservas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      produtoId INTEGER NOT NULL,
      serialNumberId INTEGER,
      quantidade REAL NOT NULL DEFAULT 1,
      dataInicio TEXT NOT NULL,
      -- Já inclui horasPreparo: o fim aqui é quando o bem volta a ficar
      -- disponível, não quando o cliente devolve.
      dataFim TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ativa',
      documentoTipo TEXT,
      documentoId INTEGER,
      locacaoItemId INTEGER,
      observacoes TEXT,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (produtoId) REFERENCES produtos(id)
    );
    CREATE INDEX IF NOT EXISTS idx_loc_res_doc
      ON locacao_reservas(documentoTipo, documentoId);
  `);

  // Indisponibilidade que não é locação: manutenção, quarentena, uso interno.
  // Sai da disponibilidade pelo mesmo cálculo de sobreposição.
  execSafe(db, `
    CREATE TABLE IF NOT EXISTS locacao_bloqueios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      produtoId INTEGER NOT NULL,
      serialNumberId INTEGER,
      quantidade REAL NOT NULL DEFAULT 1,
      dataInicio TEXT NOT NULL,
      dataFim TEXT NOT NULL,
      motivo TEXT NOT NULL,
      osId INTEGER,
      status TEXT NOT NULL DEFAULT 'ativo',
      usuario TEXT,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (produtoId) REFERENCES produtos(id)
    );
    CREATE INDEX IF NOT EXISTS idx_loc_bloq_janela
      ON locacao_bloqueios(produtoId, status, dataInicio, dataFim);
  `);

  // ─── Fase 3: o documento de locação ────────────────────────────────────────

  execSafe(db, `
    CREATE TABLE IF NOT EXISTS locacao_contratos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      numero TEXT NOT NULL UNIQUE,
      clienteId INTEGER NOT NULL,
      -- avulsa = período fechado, fatura uma vez
      -- aberta  = prazo indeterminado, fatura todo ciclo até devolver
      tipo TEXT NOT NULL DEFAULT 'avulsa',
      -- orcamento -> reservado -> emAndamento -> devolvido -> encerrado
      -- (cancelado sai de qualquer um antes de emAndamento)
      status TEXT NOT NULL DEFAULT 'orcamento',
      dataSaidaPrevista TEXT NOT NULL,
      dataRetornoPrevisto TEXT,
      dataSaidaReal TEXT,
      dataRetornoReal TEXT,
      enderecoEntrega TEXT,
      responsavelRetirada TEXT,
      documentoRetirada TEXT,
      caucaoValor REAL NOT NULL DEFAULT 0,
      -- nao_aplicavel | pendente | retido | devolvido | abatido
      caucaoStatus TEXT NOT NULL DEFAULT 'nao_aplicavel',
      caucaoContaReceberId INTEGER,
      -- Somatórios materializados: recalculados a cada mudança de item.
      -- Separados por natureza porque locação e serviço têm destino fiscal
      -- diferente (ver locacao_itens.natureza).
      valorLocacao REAL NOT NULL DEFAULT 0,
      valorServicos REAL NOT NULL DEFAULT 0,
      valorExtras REAL NOT NULL DEFAULT 0,
      valorTotal REAL NOT NULL DEFAULT 0,
      -- Só no tipo aberta: o contrato core cuida de renovação, reajuste por
      -- índice e recorrência. Ver contratos-routes.js.
      contratoCoreId INTEGER,
      diaVencimento INTEGER,
      osEntregaId INTEGER,
      osDevolucaoId INTEGER,
      -- ─── Dados do contrato impresso ───────────────────────────────────
      -- O endereço de entrega já existia; a obra tem contato e telefone
      -- próprios porque quem recebe o equipamento no canteiro quase nunca é
      -- quem assinou o contrato.
      contatoObra TEXT,
      telefoneObra TEXT,
      -- Cobrança pode ir para endereço diferente do da obra (escritório).
      enderecoCobranca TEXT,
      tipoFrete TEXT,
      -- Ordem de compra / documento do cliente que autoriza a locação.
      documentoAuxiliar TEXT,
      -- Cláusulas COPIADAS na criação, não referenciadas: o contrato assinado
      -- tem de continuar dizendo o que dizia, mesmo que a locadora mude o
      -- texto padrão depois. Mesma disciplina do checklist da OS.
      clausulas TEXT,
      -- Nota promissória: garantia do valor de REPOSIÇÃO da frota, não do
      -- aluguel (no modelo de referência, R$ 2.388,18 de promissória para
      -- R$ 230,00 de locação — 12 andaimes a R$ 199,02 de indenização).
      promissoriaEmitir INTEGER NOT NULL DEFAULT 0,
      promissoriaNumero TEXT,
      promissoriaVencimento TEXT,
      promissoriaValor REAL,
      promissoriaPraca TEXT,
      observacoes TEXT,
      usuarioCriacao TEXT,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
      dataAtualizacao TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (clienteId) REFERENCES pessoas(id)
    );
    CREATE INDEX IF NOT EXISTS idx_loc_contr_cliente ON locacao_contratos(clienteId, status);
    CREATE INDEX IF NOT EXISTS idx_loc_contr_status ON locacao_contratos(status, dataRetornoPrevisto);
    CREATE INDEX IF NOT EXISTS idx_loc_contr_core ON locacao_contratos(contratoCoreId);
  `);

  // `natureza` existe desde o primeiro dia por causa da Súmula Vinculante 31:
  // ISS não incide sobre locação de bem móvel, mas o STF afasta a súmula
  // quando locação e serviço não estão claramente separados em objeto E em
  // valor. Misturar as duas numa linha só torna a separação impossível depois
  // de o documento estar emitido.
  execSafe(db, `
    CREATE TABLE IF NOT EXISTS locacao_itens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contratoId INTEGER NOT NULL,
      produtoId INTEGER,
      serialNumberId INTEGER,
      descricao TEXT NOT NULL,
      -- locacao | servico
      natureza TEXT NOT NULL DEFAULT 'locacao',
      tipoOperacaoId INTEGER,
      quantidade REAL NOT NULL DEFAULT 1,
      dataInicio TEXT,
      dataFim TEXT,
      -- Resultado do cálculo da F1, guardado para o documento não mudar
      -- sozinho quando a tabela de preço for reajustada.
      tarifaFaixa TEXT,
      tarifaValor REAL,
      unidades REAL,
      valorUnitario REAL NOT NULL DEFAULT 0,
      valorTotal REAL NOT NULL DEFAULT 0,
      medidorSaida REAL,
      medidorRetorno REAL,
      devolvido INTEGER NOT NULL DEFAULT 0,
      dataDevolucao TEXT,
      observacoes TEXT,
      FOREIGN KEY (contratoId) REFERENCES locacao_contratos(id) ON DELETE CASCADE,
      FOREIGN KEY (produtoId) REFERENCES produtos(id)
    );
    CREATE INDEX IF NOT EXISTS idx_loc_itens_contrato ON locacao_itens(contratoId);
    CREATE INDEX IF NOT EXISTS idx_loc_itens_produto ON locacao_itens(produtoId, devolvido);
  `);

  // Espelho de contratos_eventos: o que aconteceu e não cabe numa coluna.
  execSafe(db, `
    CREATE TABLE IF NOT EXISTS locacao_eventos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contratoId INTEGER NOT NULL,
      tipo TEXT NOT NULL,
      descricao TEXT,
      statusAntes TEXT,
      statusDepois TEXT,
      valorAntes REAL,
      valorDepois REAL,
      usuario TEXT,
      data TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (contratoId) REFERENCES locacao_contratos(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_loc_ev ON locacao_eventos(contratoId, data);
  `);

  // Avalistas do contrato. Tabela própria porque são 0..N e o modelo de
  // referência imprime dois blocos — número que muda por locadora.
  execSafe(db, `
    CREATE TABLE IF NOT EXISTS locacao_avalistas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contratoId INTEGER NOT NULL,
      nome TEXT,
      cpfCnpj TEXT,
      endereco TEXT,
      telefone TEXT,
      ordem INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (contratoId) REFERENCES locacao_contratos(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_loc_avalistas ON locacao_avalistas(contratoId, ordem);
  `);

  // ─── Fase 4: retorno, avaria e acerto ──────────────────────────────────────

  execSafe(db, `
    CREATE TABLE IF NOT EXISTS locacao_avarias (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contratoId INTEGER NOT NULL,
      itemId INTEGER,
      descricao TEXT NOT NULL,
      -- leve | media | grave | perda
      gravidade TEXT NOT NULL DEFAULT 'leve',
      valorCobrado REAL NOT NULL DEFAULT 0,
      -- A foto já está na OS de devolução (os_anexos). Aqui fica só o ponteiro.
      osAnexoId INTEGER,
      cobrada INTEGER NOT NULL DEFAULT 0,
      usuario TEXT,
      dataRegistro TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (contratoId) REFERENCES locacao_contratos(id) ON DELETE CASCADE,
      FOREIGN KEY (itemId) REFERENCES locacao_itens(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_loc_avarias ON locacao_avarias(contratoId);
  `);

  // Linhas que nascem NA DEVOLUÇÃO, não na contratação: atraso, avaria,
  // medidor além da franquia, reposição. Ficam separadas dos itens porque o
  // item é o que foi combinado e o acerto é o que aconteceu.
  execSafe(db, `
    CREATE TABLE IF NOT EXISTS locacao_acertos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contratoId INTEGER NOT NULL,
      itemId INTEGER,
      -- atraso | avaria | medidor | reposicao | limpeza | entrega | desconto
      tipo TEXT NOT NULL,
      descricao TEXT NOT NULL,
      quantidade REAL NOT NULL DEFAULT 1,
      valorUnitario REAL NOT NULL DEFAULT 0,
      valorTotal REAL NOT NULL DEFAULT 0,
      natureza TEXT NOT NULL DEFAULT 'locacao',
      contaReceberId INTEGER,
      usuario TEXT,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (contratoId) REFERENCES locacao_contratos(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_loc_acertos ON locacao_acertos(contratoId, tipo);
  `);

  // ─── Fase 5: financeiro e fiscal ───────────────────────────────────────────

  // Uma linha por ciclo faturado. No tipo `avulsa` há uma só; no `aberta`, uma
  // por competência — e é ela que impede faturar o mesmo mês duas vezes.
  execSafe(db, `
    CREATE TABLE IF NOT EXISTS locacao_faturamentos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contratoId INTEGER NOT NULL,
      competencia TEXT,
      dataInicio TEXT,
      dataFim TEXT,
      valorLocacao REAL NOT NULL DEFAULT 0,
      valorServicos REAL NOT NULL DEFAULT 0,
      valorExtras REAL NOT NULL DEFAULT 0,
      valorTotal REAL NOT NULL DEFAULT 0,
      contaReceberId INTEGER,
      faturaId INTEGER,
      nfseId INTEGER,
      nfeId INTEGER,
      status TEXT NOT NULL DEFAULT 'gerado',
      observacoes TEXT,
      usuario TEXT,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (contratoId) REFERENCES locacao_contratos(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_loc_fat ON locacao_faturamentos(contratoId, competencia);
  `);

  // Granularidade por evento×canal — cópia deliberada de os_notificacoes_config
  // (db-schema.js:1667), o único padrão do repo que permite ao tenant recusar
  // UM aviso sem desligar o canal inteiro.
  execSafe(db, `
    CREATE TABLE IF NOT EXISTS locacao_notificacoes_config (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      evento TEXT NOT NULL,
      canal TEXT NOT NULL,
      template TEXT,
      ativo INTEGER NOT NULL DEFAULT 1,
      UNIQUE (evento, canal)
    );

    CREATE TABLE IF NOT EXISTS locacao_notificacoes_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      evento TEXT NOT NULL,
      canal TEXT NOT NULL,
      contratoId INTEGER,
      destino TEXT,
      sucesso INTEGER NOT NULL DEFAULT 0,
      erro TEXT,
      data TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_loc_notif_log ON locacao_notificacoes_log(contratoId, data);
  `);

  // ─── Fase 6: manutenção por uso e BI ───────────────────────────────────────

  execSafe(db, `
    CREATE TABLE IF NOT EXISTS locacao_medidor_leituras (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      produtoId INTEGER NOT NULL,
      serialNumberId INTEGER,
      contratoId INTEGER,
      tipo TEXT NOT NULL,
      valor REAL NOT NULL,
      -- saida | retorno | manual | manutencao
      origem TEXT NOT NULL DEFAULT 'manual',
      usuario TEXT,
      data TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (produtoId) REFERENCES produtos(id)
    );
    CREATE INDEX IF NOT EXISTS idx_loc_medidor
      ON locacao_medidor_leituras(produtoId, serialNumberId, data);
  `);

  execSafe(db, `
    CREATE TABLE IF NOT EXISTS locacao_manutencao_planos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      produtoId INTEGER NOT NULL,
      serialNumberId INTEGER,
      descricao TEXT NOT NULL,
      -- horimetro | km | dias
      tipo TEXT NOT NULL,
      intervalo REAL NOT NULL,
      ultimoValor REAL NOT NULL DEFAULT 0,
      ultimaData TEXT,
      osTipoId INTEGER,
      ativo INTEGER NOT NULL DEFAULT 1,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (produtoId) REFERENCES produtos(id)
    );
    CREATE INDEX IF NOT EXISTS idx_loc_manut ON locacao_manutencao_planos(produtoId, ativo);
  `);

  // ─── Compatibilidade com tabelas de versões anteriores ─────────────────────
  //
  // Roda DEPOIS de todos os CREATE TABLE: se a tabela já existia, o CREATE é
  // no-op e as colunas novas precisam entrar por ALTER. Sem isto o módulo
  // parecia instalado e dava 500 na primeira consulta.
  garantirColunas(db, 'locacao_item_specs', {
    alugavel: 'INTEGER NOT NULL DEFAULT 1',
    exigeSerie: 'INTEGER NOT NULL DEFAULT 0',
    caucaoPadrao: 'REAL NOT NULL DEFAULT 0',
    caucaoPercentual: 'REAL',
    caucaoPercentualBase: "TEXT DEFAULT 'locacao'",
    horasPreparo: 'REAL NOT NULL DEFAULT 0',
    medidorTipo: "TEXT NOT NULL DEFAULT 'nenhum'",
    franquiaPorDia: 'REAL',
    valorReposicao: 'REAL',
    reposicaoPercentual: 'REAL',
    observacoes: 'TEXT',
  });
  garantirColunas(db, 'locacao_reservas', {
    serialNumberId: 'INTEGER',
    locacaoItemId: 'INTEGER',
    observacoes: 'TEXT',
  });
  garantirColunas(db, 'locacao_contratos', {
    documentoRetirada: 'TEXT',
    contratoCoreId: 'INTEGER',
    osEntregaId: 'INTEGER',
    osDevolucaoId: 'INTEGER',
    caucaoContaReceberId: 'INTEGER',
    diaVencimento: 'INTEGER',
    contatoObra: 'TEXT',
    telefoneObra: 'TEXT',
    enderecoCobranca: 'TEXT',
    tipoFrete: 'TEXT',
    documentoAuxiliar: 'TEXT',
    clausulas: 'TEXT',
    promissoriaEmitir: 'INTEGER NOT NULL DEFAULT 0',
    promissoriaNumero: 'TEXT',
    promissoriaVencimento: 'TEXT',
    promissoriaValor: 'REAL',
    promissoriaPraca: 'TEXT',
  });
  garantirColunas(db, 'locacao_itens', {
    tipoOperacaoId: 'INTEGER',
    medidorSaida: 'REAL',
    medidorRetorno: 'REAL',
    devolvido: 'INTEGER NOT NULL DEFAULT 0',
    dataDevolucao: 'TEXT',
  });

  // Índices por último e tolerantes: dependem das colunas acima e nunca podem
  // derrubar o boot do tenant. Ver indexSafe.
  indexSafe(db, 'CREATE INDEX IF NOT EXISTS idx_loc_specs_alugavel ON locacao_item_specs(alugavel)');

  // Remove a coluna `categoria` de bancos que já a criaram. A categoria passa
  // a ser sempre a do cadastro do produto — manter a coluna aqui deixaria um
  // campo morto que um dia alguém volta a preencher, recriando a divergência.
  // Só executa quando não há dado nenhum nela: se algum tenant tiver
  // classificado itens, a coluna fica e o aviso aparece no log.
  try {
    const cols = db.prepare('PRAGMA table_info(locacao_item_specs)').all().map(c => c.name);
    if (cols.includes('categoria')) {
      const comDado = db.prepare(
        "SELECT COUNT(*) n FROM locacao_item_specs WHERE categoria IS NOT NULL AND categoria <> ''"
      ).get().n;
      if (comDado === 0) {
        db.exec('DROP INDEX IF EXISTS idx_loc_specs_alugavel');
        db.exec('ALTER TABLE locacao_item_specs DROP COLUMN categoria');
        db.exec('CREATE INDEX IF NOT EXISTS idx_loc_specs_alugavel ON locacao_item_specs(alugavel)');
      } else {
        console.warn(`[locacao-schema] locacao_item_specs.categoria mantida: ${comDado} linha(s) `
          + 'com valor. A categoria usada pelo módulo é a de produtos.categoria.');
      }
    }
  } catch (err) {
    // DROP COLUMN exige SQLite 3.35+. Falhar aqui não pode derrubar o tenant:
    // a coluna sobra sem uso e o módulo funciona igual.
    console.warn('[locacao-schema] não removeu locacao_item_specs.categoria:', err.message);
  }
  indexSafe(db, 'CREATE INDEX IF NOT EXISTS idx_loc_res_janela ON locacao_reservas(produtoId, status, dataInicio, dataFim)');
  indexSafe(db, 'CREATE INDEX IF NOT EXISTS idx_loc_res_serial ON locacao_reservas(serialNumberId, status)');
  indexSafe(db, `CREATE UNIQUE INDEX IF NOT EXISTS idx_loc_fat_competencia
                 ON locacao_faturamentos(contratoId, competencia)
                 WHERE competencia IS NOT NULL AND status <> 'cancelado'`);
}

module.exports = { initLocacaoSchema };
