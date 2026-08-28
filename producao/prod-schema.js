/**
 * prod-schema.js — Schema do módulo Produção (ordem de produção para
 * manufatura discreta).
 *
 * Modelo: NÃO altera tabelas core. O item produzido continua sendo `produtos`
 * (herda NCM/CFOP/CST, motor de tributação, estoque e custo médio de graça);
 * tudo que é do processo produtivo mora em tabelas `prod_*` que referenciam o
 * core por FK.
 *
 * O núcleo é neutro de segmento: ficha, ordem, recurso, etapa, ensaio,
 * apontamento. O vocabulário e o conjunto inicial de etapas vêm do PERFIL DE
 * INDÚSTRIA (producao/perfis.js) — é ele que faz "recurso" ser chamado de
 * "forma/pista" numa fábrica de pré-moldados e de "máquina" numa metalúrgica,
 * sem duplicar uma linha de código.
 *
 *   produtos (core)
 *     ├── prod_fichas         (1:1 — modo, quantidade base, ensaio, tempo)
 *     └── prod_ficha_itens   (1:N — insumos com perda)
 *
 *   movimentacoes_estoque (core) ← baixa de insumo e entrada do item acabado,
 *                                  por origem='prod_ordem' / 'prod_ordem_producao'
 *   funcionarios / funcionarios_ponto (core) ← o homem-hora do denominador
 *   os_ordens (core)             ← montagem no cliente, quando contratada
 *   pessoas (core)               ← o cliente do projeto
 *
 * IMPORTANTE — por que este arquivo é chamado pelo db-schema.js:
 * o migrarDB() de um *-routes.js roda dentro do runInBootContext contra o
 * BOOT_STUB e é no-op em multi-tenant; não alcança nenhum tenant existente.
 * Quem aplica schema em tenant existente é o db-schema.js. Este módulo é
 * chamado de lá (padrão do restaurante/farmácia/posto/locação).
 *
 * Todo o schema das fases 1 e 2 é criado de uma vez, de propósito: tabela
 * vazia não custa nada e evita um restart de produção por fase.
 *
 * ─── POR QUE A FICHA NÃO É `produto_kit_itens` (leia antes de "simplificar") ──
 * `produto_kit_itens` (db-schema.js:1161) é composição de VENDA: é lida na
 * saída do pedido. Três impedimentos:
 *   1. não tem perda, e a perda de processo (sobra, aparas, pontas de corte) é
 *      o que separa custo teórico de custo real na manufatura;
 *   2. o UNIQUE(pai, filho) proíbe o mesmo insumo em duas linhas;
 *   3. pendurar produção nela faria a VENDA da peça explodir os insumos,
 *      baixando estoque duas vezes.
 * Mesma decisão que a locação tomou com `reservas_estoque`, pelo mesmo motivo:
 * a estrutura existente responde outra pergunta.
 *
 * ─── A IDENTIFICAÇÃO INDIVIDUAL NÃO É OPÇÃO DE TELA ──────────────────────────
 * `prod_fichas.exigeIdentificacao` é DERIVADO (ver producao/ficha.js): vale 1
 * sempre que modo='projeto' ou exigeEnsaioLiberacao=1. É ela que amarra
 * unidade ↔ lote de processo ↔ ensaio; sem isso o ensaio não prova nada sobre
 * a unidade que foi para o cliente. Numa fábrica de pré-moldados é o lastro da
 * NBR 9062; em qualquer outra, é a rastreabilidade que o cliente audita.
 * Configurável, seria desligada na primeira semana apertada.
 *
 * ─── FORMATO DE DATA ─────────────────────────────────────────────────────────
 * Instantes são TEXT 'YYYY-MM-DD HH:MM:SS' (o mesmo do CURRENT_TIMESTAMP do
 * SQLite); datas puras são TEXT 'YYYY-MM-DD'. Comparação é lexicográfica, então
 * o formato TEM de ser uniforme — normalize na entrada com as funções de
 * producao/prod-util.js.
 */

// CREATE/ALTER tolerantes: o schema roda em todos os tenants, com históricos
// diferentes. Mesmo par de helpers do locacao-schema/farmacia-schema.
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
 * Índice tolerante. Índice que não pôde ser criado degrada desempenho ou deixa
 * de garantir unicidade — nunca justifica impedir o tenant de subir, e o
 * db-schema.js chama este módulo sem try.
 */
function indexSafe(db, sql) {
  try {
    db.exec(sql);
  } catch (e) {
    if (/already exists/i.test(e.message)) return;
    if (/no such column/i.test(e.message) || /no such table/i.test(e.message)
        || /UNIQUE constraint failed/i.test(e.message) || /duplicate/i.test(e.message)) {
      console.warn('[prod-schema] índice não criado:', e.message.trim(),
        '— o módulo segue funcionando; corrija os dados e reinicie para recriá-lo.');
      return;
    }
    throw e;
  }
}

/**
 * Acrescenta colunas que faltam numa tabela já existente. `CREATE TABLE IF NOT
 * EXISTS` é no-op quando a tabela existe — sem isto, tabela criada por versão
 * anterior do módulo fica sem as colunas novas e dá 500 em runtime.
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

function initProducaoSchema(db) {
  // ─── F1.1: o tipo de peça ──────────────────────────────────────────────────

  // 1:1 com `produtos`, espelhando locacao_item_specs. Produto sem linha aqui
  // simplesmente não é peça produzida — não existe coluna nova em `produtos`.
  execSafe(db, `
    CREATE TABLE IF NOT EXISTS prod_fichas (
      produtoId INTEGER PRIMARY KEY,
      -- estoque = produz para repor saldo, item fungível
      -- projeto = produz sob encomenda, item vinculado a um projeto/contrato
      modo TEXT NOT NULL DEFAULT 'estoque',
      -- DERIVADO de modo/exigeEnsaioLiberacao pelo backend (ficha.js). Nunca
      -- vem da tela. Ver o bloco no topo.
      exigeIdentificacao INTEGER NOT NULL DEFAULT 0,

      -- ─── A base do indicador de produtividade ──────────────────────────
      -- quantidadeBase é quanto UMA unidade produzida representa na unidade
      -- que a fábrica usa para medir esforço, e unidadeBase diz qual é.
      -- Numa fábrica de concreto é m³ por peça; numa metalúrgica, kg; numa
      -- gráfica, milheiro; numa serralheria, m². O painel divide isso pelo
      -- homem-hora — por isso a unidade é do cadastro, não do código.
      quantidadeBase REAL NOT NULL DEFAULT 0,
      unidadeBase TEXT NOT NULL DEFAULT 'UN',

      pesoKg REAL NOT NULL DEFAULT 0,
      comprimentoM REAL,
      larguraM REAL,
      alturaM REAL,

      -- ─── Liberação por ensaio (o que era a trava da protensão) ─────────
      -- Genérico de propósito: existe processo em que o item só pode sair do
      -- recurso quando uma MEDIÇÃO atinge um limite. No concreto é o fck de
      -- transferência antes de cortar a cordoalha; numa fábrica de tintas é a
      -- viscosidade; numa de tubos, o teste de estanqueidade; numa solda, o
      -- ensaio de penetração. A mecânica é a mesma: mede, compara, libera.
      exigeEnsaioLiberacao INTEGER NOT NULL DEFAULT 0,
      ensaioTipoId INTEGER,
      -- O valor mínimo que o ensaio precisa atingir. Congelado na ordem
      -- quando o processo inicia (ver prod_ordens.ensaioLimiteExigido).
      ensaioLimiteLiberacao REAL,
      -- Limite do ensaio final de conformidade (o fck de projeto aos 28 dias,
      -- no vocabulário do concreto). Não bloqueia: atesta.
      ensaioLimiteConformidade REAL,

      -- Horas entre o início do processo e a liberação prevista: cura,
      -- secagem, resfriamento, descanso, polimerização. É o que diz quando o
      -- recurso volta a ficar livre.
      tempoProcessoHoras REAL NOT NULL DEFAULT 24,
      -- Recurso padrão (forma, molde, máquina, forno, linha).
      recursoPadraoId INTEGER,
      -- Quantas unidades saem de um ciclo do recurso.
      unidadesPorCiclo REAL NOT NULL DEFAULT 1,
      codigoProjeto TEXT,
      ativo INTEGER NOT NULL DEFAULT 1,
      observacoes TEXT,
      dataAtualizacao TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (produtoId) REFERENCES produtos(id) ON DELETE CASCADE
    );
  `);

  // ─── Etapas de produção: CADASTRO, não constante ───────────────────────────
  //
  // Era um enum fixo com as etapas do concreto (armação, forma, concretagem,
  // desforma...). Uma gráfica não tem nenhuma delas. Cada tenant define as
  // suas, e o perfil de indústria semeia um conjunto inicial.
  //
  // `individual` é a etapa em que atribuir o trabalho a UMA pessoa faz
  // sentido (armação por kg, acabamento). Nas demais o apontamento é da
  // equipe — ver o cabeçalho de apontamento.js.
  //
  // `contaProducao` marca a etapa em que a unidade fica PRONTA. Só ela soma
  // produção: apontar 10 na preparação e 10 no processo não são 20 unidades,
  // são as mesmas 10 passando por duas etapas.
  execSafe(db, `
    CREATE TABLE IF NOT EXISTS prod_etapas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      codigo TEXT NOT NULL UNIQUE,
      nome TEXT NOT NULL,
      ordem INTEGER NOT NULL DEFAULT 0,
      individual INTEGER NOT NULL DEFAULT 0,
      contaProducao INTEGER NOT NULL DEFAULT 0,
      ativo INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_prod_etapas ON prod_etapas(ativo, ordem);
  `);

  // Tipos de ensaio: o que se mede, em que unidade, e com que idade.
  // No concreto: resistência em MPa aos 1/7/28 dias. Numa fábrica de tintas:
  // viscosidade em cP. O módulo não sabe o que é fck — sabe comparar número
  // com limite.
  execSafe(db, `
    CREATE TABLE IF NOT EXISTS prod_ensaio_tipos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      codigo TEXT NOT NULL UNIQUE,
      nome TEXT NOT NULL,
      unidade TEXT NOT NULL DEFAULT '',
      -- Idade padrão da medição, em dias. 0 = imediata.
      idadePadraoDias INTEGER NOT NULL DEFAULT 0,
      -- liberacao   = trava a saída do recurso
      -- conformidade = atesta o lote, não trava
      finalidade TEXT NOT NULL DEFAULT 'conformidade',
      ativo INTEGER NOT NULL DEFAULT 1
    );
  `);

  // Ficha técnica. Não é produto_kit_itens — ver o bloco no topo.
  // Consumo real = quantidade * (1 + perdaPercentual/100).
  execSafe(db, `
    CREATE TABLE IF NOT EXISTS prod_ficha_itens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fichaProdutoId INTEGER NOT NULL,
      insumoProdutoId INTEGER NOT NULL,
      -- Quantidade de projeto, por UMA peça.
      quantidade REAL NOT NULL,
      unidade TEXT NOT NULL DEFAULT 'KG',
      -- Perda de processo em %: sobra de betonada, limpeza de forma, pontas
      -- de corte do aço. 3 a 8% é o normal do segmento.
      perdaPercentual REAL NOT NULL DEFAULT 0,
      -- concreto | aco | forma | consumivel | outro — agrupa o custo no
      -- painel sem depender da categoria do produto, que é do cadastro.
      grupo TEXT NOT NULL DEFAULT 'outro',
      ordem INTEGER NOT NULL DEFAULT 0,
      observacoes TEXT,
      FOREIGN KEY (fichaProdutoId) REFERENCES prod_fichas(produtoId) ON DELETE CASCADE,
      FOREIGN KEY (insumoProdutoId) REFERENCES produtos(id)
    );
    CREATE INDEX IF NOT EXISTS idx_prod_ficha_peca ON prod_ficha_itens(fichaProdutoId);
    CREATE INDEX IF NOT EXISTS idx_prod_ficha_insumo ON prod_ficha_itens(insumoProdutoId);
  `);

  // ─── F1.2: formas e pistas — o recurso que satura ──────────────────────────

  execSafe(db, `
    CREATE TABLE IF NOT EXISTS prod_recursos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      codigo TEXT NOT NULL UNIQUE,
      descricao TEXT NOT NULL,
      -- forma | pista
      tipo TEXT NOT NULL DEFAULT 'forma',
      -- Comprimento útil da pista, em m. Numa pista de protensão cabem N
      -- peças em série até esgotar o comprimento.
      comprimentoUtilM REAL,
      capacidadePecas REAL NOT NULL DEFAULT 1,
      localizacao TEXT,
      ativo INTEGER NOT NULL DEFAULT 1,
      observacoes TEXT,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_prod_recursos_ativo ON prod_recursos(ativo, tipo);
  `);

  // Indisponibilidade da forma que não é OP: manutenção, reforma, troca de
  // molde. Sai da agenda pelo mesmo cálculo de sobreposição das OPs.
  execSafe(db, `
    CREATE TABLE IF NOT EXISTS prod_recurso_bloqueios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      formaId INTEGER NOT NULL,
      dataInicio TEXT NOT NULL,
      dataFim TEXT NOT NULL,
      motivo TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ativo',
      usuario TEXT,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (formaId) REFERENCES prod_recursos(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_prod_forma_bloq
      ON prod_recurso_bloqueios(formaId, status, dataInicio, dataFim);
  `);

  // ─── F1.3: equipes ─────────────────────────────────────────────────────────

  // O apontamento é por EQUIPE, não por pessoa: uma concretagem envolve
  // armador, montador de forma e vibrador ao mesmo tempo, e atribuir a peça a
  // uma pessoa é ficção. O rateio para indicador individual sai do ponto.
  execSafe(db, `
    CREATE TABLE IF NOT EXISTS prod_equipes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL UNIQUE,
      -- armacao | forma | concretagem | acabamento | expedicao | mista
      especialidade TEXT NOT NULL DEFAULT 'mista',
      encarregadoFuncionarioId INTEGER,
      ativo INTEGER NOT NULL DEFAULT 1,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS prod_equipe_membros (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      equipeId INTEGER NOT NULL,
      funcionarioId INTEGER NOT NULL,
      dataEntrada TEXT DEFAULT CURRENT_TIMESTAMP,
      dataSaida TEXT,
      ativo INTEGER NOT NULL DEFAULT 1,
      FOREIGN KEY (equipeId) REFERENCES prod_equipes(id) ON DELETE CASCADE,
      UNIQUE (equipeId, funcionarioId)
    );
    CREATE INDEX IF NOT EXISTS idx_prod_equipe_membros ON prod_equipe_membros(equipeId, ativo);
  `);

  // ─── F1.4: controle tecnológico do concreto ────────────────────────────────

  // Uma betonada. Serve N ordens de produção — por isso não é coluna da OP.
  execSafe(db, `
    CREATE TABLE IF NOT EXISTS prod_lotes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      codigo TEXT NOT NULL UNIQUE,
      data TEXT NOT NULL,
      -- Descrição do traço aplicado (texto: a dosagem real vem digitada, a
      -- integração com central dosadora está fora de escopo).
      traco TEXT,
      volumeM3 REAL NOT NULL DEFAULT 0,
      ensaioLimiteConformidade REAL,
      slumpMm REAL,
      temperaturaC REAL,
      cimentoTipo TEXT,
      -- Situação do lote conforme os ensaios: pendente enquanto não há corpo
      -- de prova rompido; aprovado/reprovado quando há.
      situacao TEXT NOT NULL DEFAULT 'pendente',
      usuario TEXT,
      observacoes TEXT,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_prod_lotes_data ON prod_lotes(data);
  `);

  // Corpo de prova. `idadeDias` distingue o ensaio de transferência (tipicamente
  // 1 a 3 dias, o que libera a protensão) do de projeto (28 dias).
  execSafe(db, `
    CREATE TABLE IF NOT EXISTS prod_ensaios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      loteId INTEGER NOT NULL,
      identificacao TEXT NOT NULL,
      dataMoldagem TEXT NOT NULL,
      -- Idade prevista de ruptura. 1..3 = transferência; 7 = controle;
      -- 28 = projeto.
      idadeDias INTEGER NOT NULL DEFAULT 28,
      dataRuptura TEXT,
      resistenciaMpa REAL,
      -- transferencia | controle | projeto
      finalidade TEXT NOT NULL DEFAULT 'projeto',
      -- NULL enquanto não rompido; 0/1 depois. Quem decide é tecnologico.js,
      -- comparando com o fck exigido pela finalidade.
      aprovado INTEGER,
      usuario TEXT,
      observacoes TEXT,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (loteId) REFERENCES prod_lotes(id) ON DELETE CASCADE,
      UNIQUE (loteId, identificacao)
    );
    CREATE INDEX IF NOT EXISTS idx_prod_cp_lote ON prod_ensaios(loteId, finalidade);
  `);

  // ─── F1.5: ordem de produção ───────────────────────────────────────────────

  execSafe(db, `
    CREATE TABLE IF NOT EXISTS prod_ordens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      numero TEXT NOT NULL UNIQUE,
      produtoId INTEGER NOT NULL,
      -- estoque = reposição de catálogo | obra = puxada por prod_projeto_itens
      origem TEXT NOT NULL DEFAULT 'estoque',
      projetoId INTEGER,
      projetoItemId INTEGER,
      formaId INTEGER,
      quantidadePlanejada REAL NOT NULL DEFAULT 1,
      quantidadeProduzida REAL NOT NULL DEFAULT 0,
      quantidadeRefugo REAL NOT NULL DEFAULT 0,
      -- planejada -> liberada -> em_processo -> curando -> liberada_saida
      --           -> concluida   (cancelada sai de planejada/liberada)
      status TEXT NOT NULL DEFAULT 'planejada',
      dataPlanejada TEXT,
      dataInicioProcesso TEXT,
      dataFimPrevisto TEXT,
      dataFim TEXT,
      dataConclusao TEXT,
      loteId INTEGER,
      -- fck de transferência CONGELADO na concretagem, copiado de
      -- prod_fichas.ensaioLimiteLiberacao.
      --
      -- Existe porque a trava da protensão compara contra este número, e
      -- editar o cadastro da peça depois de em_processo rebaixaria a exigência
      -- de uma peça que já está na pista: um ensaio de 22 MPa passaria a
      -- "aprovar" a peça que foi projetada para 30. Mesma lógica da ficha
      -- congelada na liberação — o que a OP prometeu não muda no meio dela.
      ensaioLimiteExigido REAL,
      -- Custo teórico congelado na liberação (a ficha pode mudar depois).
      custoTeorico REAL NOT NULL DEFAULT 0,
      custoInsumo REAL NOT NULL DEFAULT 0,
      custoMaoObra REAL NOT NULL DEFAULT 0,
      custoTotal REAL NOT NULL DEFAULT 0,
      observacoes TEXT,
      usuarioCriacao TEXT,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
      dataAtualizacao TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (produtoId) REFERENCES produtos(id)
    );
    CREATE INDEX IF NOT EXISTS idx_prod_ordens_status ON prod_ordens(status, dataPlanejada);
    CREATE INDEX IF NOT EXISTS idx_prod_ordens_produto ON prod_ordens(produtoId, status);
    CREATE INDEX IF NOT EXISTS idx_prod_ordens_obra ON prod_ordens(projetoId);
    CREATE INDEX IF NOT EXISTS idx_prod_ordens_forma ON prod_ordens(formaId, status);
  `);

  // Explosão da ficha congelada na liberação da OP. `quantidadeReal` só é
  // preenchida na baixa: a diferença entre prevista e real é a perda que
  // ninguém mediu, e é ela que o painel de custo mostra.
  execSafe(db, `
    CREATE TABLE IF NOT EXISTS prod_ordem_insumos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      opId INTEGER NOT NULL,
      insumoProdutoId INTEGER NOT NULL,
      quantidadePrevista REAL NOT NULL DEFAULT 0,
      quantidadeReal REAL,
      unidade TEXT,
      grupo TEXT,
      custoUnitario REAL NOT NULL DEFAULT 0,
      custoTotal REAL NOT NULL DEFAULT 0,
      -- Ponteiro para movimentacoes_estoque: prova de que a baixa ocorreu e
      -- caminho do estorno no cancelamento.
      movimentacaoId INTEGER,
      FOREIGN KEY (opId) REFERENCES prod_ordens(id) ON DELETE CASCADE,
      FOREIGN KEY (insumoProdutoId) REFERENCES produtos(id)
    );
    CREATE INDEX IF NOT EXISTS idx_prod_ordem_insumos ON prod_ordem_insumos(opId);
  `);

  // Linha do tempo da OP: o que aconteceu e não cabe numa coluna. Espelha
  // locacao_eventos. É aqui que fica o bypass de liberação sem ensaio.
  execSafe(db, `
    CREATE TABLE IF NOT EXISTS prod_ordem_eventos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      opId INTEGER NOT NULL,
      tipo TEXT NOT NULL,
      descricao TEXT,
      statusAntes TEXT,
      statusDepois TEXT,
      usuario TEXT,
      data TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (opId) REFERENCES prod_ordens(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_prod_ordem_eventos ON prod_ordem_eventos(opId, data);
  `);

  // ─── F1.6: apontamento de chão de fábrica ──────────────────────────────────

  execSafe(db, `
    CREATE TABLE IF NOT EXISTS prod_apontamentos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      opId INTEGER NOT NULL,
      equipeId INTEGER,
      -- Preenchido só quando a etapa é individual de fato (armação por kg,
      -- acabamento). Em concretagem fica NULL — ver prod_equipes.
      funcionarioId INTEGER,
      -- armacao | forma | concretagem | desforma | acabamento | carga
      etapa TEXT NOT NULL,
      data TEXT NOT NULL,
      horaInicio TEXT,
      horaFim TEXT,
      -- Horas-relógio do apontamento (fim - início). NÃO é homem-hora: o
      -- homem-hora sai do ponto, em produtividade.js.
      horas REAL NOT NULL DEFAULT 0,
      -- Quantas pessoas a equipe tinha NESTE apontamento. Fallback do
      -- homem-hora quando o ponto não cobre o dia.
      pessoas INTEGER,
      quantidadeProduzida REAL NOT NULL DEFAULT 0,
      quantidadeRefugo REAL NOT NULL DEFAULT 0,
      -- Obrigatório quando quantidadeRefugo > 0: refugo sem motivo é número
      -- que não muda comportamento nenhum.
      motivoRefugo TEXT,
      observacoes TEXT,
      usuario TEXT,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (opId) REFERENCES prod_ordens(id) ON DELETE CASCADE,
      FOREIGN KEY (equipeId) REFERENCES prod_equipes(id)
    );
    CREATE INDEX IF NOT EXISTS idx_prod_apont_op ON prod_apontamentos(opId, etapa);
    CREATE INDEX IF NOT EXISTS idx_prod_apont_equipe ON prod_apontamentos(equipeId, data);
    CREATE INDEX IF NOT EXISTS idx_prod_apont_data ON prod_apontamentos(data);
  `);

  // ─── F1.7: a peça física identificada ──────────────────────────────────────

  // Só existe quando prod_fichas.exigeIdentificacao = 1. É o que amarra a peça
  // ao lote de concreto e, por ele, ao corpo de prova.
  execSafe(db, `
    CREATE TABLE IF NOT EXISTS prod_unidades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      opId INTEGER NOT NULL,
      produtoId INTEGER NOT NULL,
      identificacao TEXT NOT NULL UNIQUE,
      loteId INTEGER,
      projetoId INTEGER,
      dataInicioProcesso TEXT,
      dataFim TEXT,
      -- produzindo | patio | expedida | montada | refugo
      status TEXT NOT NULL DEFAULT 'produzindo',
      -- Texto livre por decisão: o pátio do prospect ainda não tem
      -- endereçamento confirmado. Vira tabela quando houver ruas/quadras.
      posicaoPatio TEXT,
      pesoKg REAL,
      romaneioId INTEGER,
      observacoes TEXT,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (opId) REFERENCES prod_ordens(id) ON DELETE CASCADE,
      FOREIGN KEY (produtoId) REFERENCES produtos(id)
    );
    CREATE INDEX IF NOT EXISTS idx_prod_pp_op ON prod_unidades(opId);
    CREATE INDEX IF NOT EXISTS idx_prod_pp_status ON prod_unidades(status, projetoId);
    CREATE INDEX IF NOT EXISTS idx_prod_pp_lote ON prod_unidades(loteId);
  `);

  // ─── F2.1: obra ────────────────────────────────────────────────────────────

  execSafe(db, `
    CREATE TABLE IF NOT EXISTS prod_projetos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      numero TEXT NOT NULL UNIQUE,
      clienteId INTEGER NOT NULL,
      nome TEXT NOT NULL,
      endereco TEXT,
      cidade TEXT,
      uf TEXT,
      -- Opcional por decisão do prospect (ele não sabe se monta). Quando 1,
      -- a medição separa fornecimento (NF-e) de montagem (NFS-e, item 7.02)
      -- e a entrega abre OS.
      comMontagem INTEGER NOT NULL DEFAULT 0,
      -- orcamento -> contratada -> produzindo -> entregando -> concluida
      --           (cancelada sai de orcamento/contratada)
      status TEXT NOT NULL DEFAULT 'orcamento',
      pedidoId INTEGER,
      valorContratado REAL NOT NULL DEFAULT 0,
      valorMedido REAL NOT NULL DEFAULT 0,
      dataContrato TEXT,
      dataPrevistaEntrega TEXT,
      dataConclusao TEXT,
      responsavelCliente TEXT,
      observacoes TEXT,
      usuarioCriacao TEXT,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
      dataAtualizacao TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (clienteId) REFERENCES pessoas(id)
    );
    CREATE INDEX IF NOT EXISTS idx_prod_projetos_cliente ON prod_projetos(clienteId, status);
    CREATE INDEX IF NOT EXISTS idx_prod_projetos_status ON prod_projetos(status, dataPrevistaEntrega);
  `);

  execSafe(db, `
    CREATE TABLE IF NOT EXISTS prod_projeto_itens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      projetoId INTEGER NOT NULL,
      produtoId INTEGER NOT NULL,
      descricao TEXT,
      quantidade REAL NOT NULL DEFAULT 1,
      quantidadeProduzida REAL NOT NULL DEFAULT 0,
      quantidadeEntregue REAL NOT NULL DEFAULT 0,
      valorUnitario REAL NOT NULL DEFAULT 0,
      valorTotal REAL NOT NULL DEFAULT 0,
      -- Valor da montagem por peça, quando comMontagem=1. Separado do
      -- fornecimento desde o cadastro porque o destino fiscal é outro.
      valorMontagemUnitario REAL NOT NULL DEFAULT 0,
      observacoes TEXT,
      FOREIGN KEY (projetoId) REFERENCES prod_projetos(id) ON DELETE CASCADE,
      FOREIGN KEY (produtoId) REFERENCES produtos(id)
    );
    CREATE INDEX IF NOT EXISTS idx_prod_projeto_itens ON prod_projeto_itens(projetoId);
  `);

  // ─── F2.2: expedição ───────────────────────────────────────────────────────

  // Carga. O peso e o comprimento não são decoração: prancha tem limite legal,
  // e a sequência de descarga é o que evita descarregar o caminhão inteiro
  // para chegar na peça que monta primeiro.
  execSafe(db, `
    CREATE TABLE IF NOT EXISTS prod_romaneios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      numero TEXT NOT NULL UNIQUE,
      projetoId INTEGER,
      data TEXT NOT NULL,
      veiculoPlaca TEXT,
      veiculoTipo TEXT,
      motorista TEXT,
      capacidadeKg REAL,
      pesoTotalKg REAL NOT NULL DEFAULT 0,
      comprimentoMaiorM REAL,
      -- montagem -> carregado -> transito -> entregue (cancelado antes de
      -- carregado)
      status TEXT NOT NULL DEFAULT 'montagem',
      osMontagemId INTEGER,
      dataSaida TEXT,
      dataEntrega TEXT,
      observacoes TEXT,
      usuarioCriacao TEXT,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (projetoId) REFERENCES prod_projetos(id)
    );
    CREATE INDEX IF NOT EXISTS idx_prod_romaneios ON prod_romaneios(projetoId, status);
  `);

  // `sequenciaDescarga` menor = sai do caminhão primeiro = subiu por último.
  execSafe(db, `
    CREATE TABLE IF NOT EXISTS prod_romaneio_itens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      romaneioId INTEGER NOT NULL,
      unidadeId INTEGER,
      produtoId INTEGER NOT NULL,
      -- Peça de catálogo não tem identificação individual: vai por quantidade.
      quantidade REAL NOT NULL DEFAULT 1,
      pesoKg REAL NOT NULL DEFAULT 0,
      sequenciaDescarga INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (romaneioId) REFERENCES prod_romaneios(id) ON DELETE CASCADE,
      FOREIGN KEY (produtoId) REFERENCES produtos(id)
    );
    CREATE INDEX IF NOT EXISTS idx_prod_rom_itens ON prod_romaneio_itens(romaneioId, sequenciaDescarga);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_prod_rom_peca
      ON prod_romaneio_itens(unidadeId) WHERE unidadeId IS NOT NULL;
  `);

  // ─── F2.3: medição ─────────────────────────────────────────────────────────

  // Uma linha por competência faturada da obra. O UNIQUE impede faturar a
  // mesma competência duas vezes — mesma proteção de locacao_faturamentos.
  execSafe(db, `
    CREATE TABLE IF NOT EXISTS prod_medicoes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      projetoId INTEGER NOT NULL,
      competencia TEXT,
      numero INTEGER NOT NULL DEFAULT 1,
      dataInicio TEXT,
      dataFim TEXT,
      valorFornecimento REAL NOT NULL DEFAULT 0,
      valorMontagem REAL NOT NULL DEFAULT 0,
      valorTotal REAL NOT NULL DEFAULT 0,
      contaReceberId INTEGER,
      nfeId INTEGER,
      nfseId INTEGER,
      status TEXT NOT NULL DEFAULT 'gerada',
      observacoes TEXT,
      usuario TEXT,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (projetoId) REFERENCES prod_projetos(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_prod_medicoes ON prod_medicoes(projetoId, competencia);
  `);

  execSafe(db, `
    CREATE TABLE IF NOT EXISTS prod_medicao_itens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      medicaoId INTEGER NOT NULL,
      projetoItemId INTEGER,
      romaneioId INTEGER,
      descricao TEXT NOT NULL,
      -- fornecimento | montagem — o que decide NF-e ou NFS-e.
      natureza TEXT NOT NULL DEFAULT 'fornecimento',
      quantidade REAL NOT NULL DEFAULT 1,
      valorUnitario REAL NOT NULL DEFAULT 0,
      valorTotal REAL NOT NULL DEFAULT 0,
      FOREIGN KEY (medicaoId) REFERENCES prod_medicoes(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_prod_med_itens ON prod_medicao_itens(medicaoId);
  `);

  // ─── Compatibilidade com tabelas de versões anteriores ─────────────────────
  //
  // Roda DEPOIS de todos os CREATE TABLE: se a tabela já existia, o CREATE é
  // no-op e as colunas novas precisam entrar por ALTER.
  garantirColunas(db, 'prod_fichas', {
    modo: "TEXT NOT NULL DEFAULT 'estoque'",
    exigeIdentificacao: 'INTEGER NOT NULL DEFAULT 0',
    quantidadeBase: 'REAL NOT NULL DEFAULT 0',
    unidadeBase: "TEXT NOT NULL DEFAULT 'UN'",
    pesoKg: 'REAL NOT NULL DEFAULT 0',
    exigeEnsaioLiberacao: 'INTEGER NOT NULL DEFAULT 0',
    ensaioTipoId: 'INTEGER',
    ensaioLimiteConformidade: 'REAL',
    ensaioLimiteLiberacao: 'REAL',
    tempoProcessoHoras: 'REAL NOT NULL DEFAULT 24',
    recursoPadraoId: 'INTEGER',
    unidadesPorCiclo: 'REAL NOT NULL DEFAULT 1',
    codigoProjeto: 'TEXT',
  });
  garantirColunas(db, 'prod_ficha_itens', {
    perdaPercentual: 'REAL NOT NULL DEFAULT 0',
    grupo: "TEXT NOT NULL DEFAULT 'outro'",
  });
  garantirColunas(db, 'prod_ordens', {
    projetoItemId: 'INTEGER',
    loteId: 'INTEGER',
    custoTeorico: 'REAL NOT NULL DEFAULT 0',
    dataFimPrevisto: 'TEXT',
    ensaioLimiteExigido: 'REAL',
  });
  garantirColunas(db, 'prod_apontamentos', {
    pessoas: 'INTEGER',
    motivoRefugo: 'TEXT',
    funcionarioId: 'INTEGER',
  });
  garantirColunas(db, 'prod_unidades', {
    romaneioId: 'INTEGER',
    posicaoPatio: 'TEXT',
    projetoId: 'INTEGER',
  });

  // Índices por último e tolerantes: dependem das colunas acima e nunca podem
  // derrubar o boot do tenant. Ver indexSafe.
  indexSafe(db, 'CREATE INDEX IF NOT EXISTS idx_prod_fichas_modo ON prod_fichas(modo, ativo)');
  indexSafe(db, 'CREATE INDEX IF NOT EXISTS idx_prod_pp_romaneio ON prod_unidades(romaneioId)');
  indexSafe(db, `CREATE UNIQUE INDEX IF NOT EXISTS idx_prod_med_competencia
                 ON prod_medicoes(projetoId, competencia)
                 WHERE competencia IS NOT NULL AND status <> 'cancelada'`);
}

module.exports = { initProducaoSchema };
