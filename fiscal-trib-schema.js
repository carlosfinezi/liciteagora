/**
 * fiscal-trib-schema.js — schema do motor de tributação por regime.
 *
 * Isolado do db-schema principal pelo mesmo motivo de sc-schema/bnc-schema:
 * é um bloco grande e autocontido.
 *
 * Chamado de DOIS lugares, de propósito:
 *   - db-schema.js (initSchema)      → alcança os tenants EXISTENTES no restart
 *   - nf-avulsa-routes.js (migrar)   → alcança tenant NOVO, via applyRouteMigrations,
 *                                       quando `faturas` já foi criada por faturas-routes
 * Em tenant novo o initSchema roda ANTES de faturas existir, então os ALTERs daqui
 * falhariam calados — é a 2ª chamada que os pega. Tudo é idempotente.
 *
 * O modelo segue o de ERPs maduros (referência: Solution ERP, rotina de pré-nota):
 * a tributação não é digitada nota a nota, ela é RESOLVIDA por contexto
 * (operação × produto/NCM × UF × perfil do destinatário) e o que foi resolvido
 * fica registrado com a memória de cálculo, para auditoria.
 */

function alterSafe(db, sql) { try { db.exec(sql); } catch { /* coluna/tabela já existe */ } }

function initFiscalTribSchema(db) {
  // ─── Matriz de regras ──────────────────────────────────────────────────────
  // Campo de contexto NULL = "vale para qualquer". A regra escolhida é a de maior
  // especificidade (nº de campos de contexto preenchidos), desempatada por
  // prioridade e, por último, pelo id mais recente.
  db.exec(`
    CREATE TABLE IF NOT EXISTS fiscal_regras_trib (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      descricao TEXT NOT NULL,
      prioridade INTEGER DEFAULT 10,
      ativo INTEGER DEFAULT 1,

      -- Contexto de aplicação (NULL = qualquer)
      regimeEmitente INTEGER,      -- CRT: 1=SN, 2=SN excesso, 3=Normal, 4=MEI
      tipoOperacaoId INTEGER,      -- a "Operação" (tipos_operacao)
      cfop TEXT,
      ncmPrefixo TEXT,             -- casa por prefixo: '3105' pega 31051000
      produtoId INTEGER,
      ufOrigem TEXT,
      ufDestino TEXT,
      ambito TEXT,                 -- 'interna' | 'interestadual' | 'exterior'
      tipoContribuinte TEXT,       -- 'contribuinte' | 'isento' | 'nao_contribuinte'
      consumidorFinal INTEGER,     -- 0 | 1

      -- ICMS próprio
      cstIcms TEXT,                -- regime normal: 00,10,20,30,40,41,50,51,60,70,90
      csosnIcms TEXT,              -- Simples: 101,102,103,201,202,203,300,400,500,900
      modBC INTEGER,               -- 0=Margem, 1=Pauta, 2=Preço tabelado, 3=Valor da operação
      pIcms REAL,
      pRedBC REAL,                 -- redução de base (%) — o que a NF de insumo agrícola usa
      pFCP REAL,
      pDif REAL,                   -- diferimento (%)
      motDesIcms INTEGER,          -- motivo da desoneração (CST 40/41/50)

      -- ICMS ST
      modBCST INTEGER,
      pMVAST REAL,
      pRedBCST REAL,
      pIcmsST REAL,
      pFCPST REAL,

      -- IPI
      cstIpi TEXT,
      pIpi REAL,

      -- PIS / COFINS
      cstPis TEXT,
      pPis REAL,
      cstCofins TEXT,
      pCofins REAL,

      observacaoFiscal TEXT,       -- vai para infAdProd/infCpl (ex.: base legal da redução)
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
      dataAtualizacao TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_regras_trib_busca
      ON fiscal_regras_trib(ativo, regimeEmitente, tipoOperacaoId);
    CREATE INDEX IF NOT EXISTS idx_regras_trib_prio
      ON fiscal_regras_trib(prioridade DESC, id DESC);
  `);

  // ─── Camada 3 (2026-08-25): vigência, benefício fiscal e DIFAL ────────────
  // Vigência: alíquota muda por decreto, com data. Sem isto, reemitir uma nota
  // antiga aplica a regra de hoje. É o que o Solution guarda em toda linha da
  // matriz como Data Validade Inicial/Final.
  for (const col of [
    'vigenciaInicio TEXT',   // 'YYYY-MM-DD' — NULL = vale desde sempre
    'vigenciaFim TEXT',      // 'YYYY-MM-DD' — NULL = sem prazo
    // cBenef: obrigatório no XML em várias UFs quando a operação tem benefício
    // fiscal (é o caso de qualquer redução de base). Vive no grupo <prod>.
    'codBenef TEXT',
    // DIFAL (EC 87/2015): partilha na venda interestadual a não-contribuinte.
    // Quando a regra não define, cai na tabela de alíquotas por UF.
    'pFcpUFDest REAL',
  ]) {
    alterSafe(db, `ALTER TABLE fiscal_regras_trib ADD COLUMN ${col}`);
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_regras_trib_vigencia
             ON fiscal_regras_trib(vigenciaInicio, vigenciaFim)`);

  // ─── Alíquotas internas por UF ─────────────────────────────────────────────
  // Necessárias para calcular o DIFAL: a partilha usa a alíquota INTERNA da UF de
  // destino, que o emitente não tem como deduzir do próprio cadastro. É o
  // equivalente da rotina 1924 do Solution ("Consulta da alíquota interna do ICMS").
  //
  // As 27 UFs são semeadas SEM alíquota de propósito. Semear número aqui seria
  // inventar dado fiscal: as alíquotas internas mudaram em vários estados nos
  // últimos anos e errar produz nota com imposto errado, calada. Sem o valor
  // cadastrado o DIFAL não é calculado e a emissão avisa qual UF falta.
  db.exec(`
    CREATE TABLE IF NOT EXISTS fiscal_aliquotas_uf (
      uf TEXT PRIMARY KEY,
      aliquotaInterna REAL,      -- % geral de ICMS interno da UF
      pFcp REAL,                 -- % do Fundo de Combate à Pobreza
      observacao TEXT,
      dataAtualizacao TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);
  const UFS = ['AC','AL','AM','AP','BA','CE','DF','ES','GO','MA','MG','MS','MT','PA','PB',
    'PE','PI','PR','RJ','RN','RO','RR','RS','SC','SE','SP','TO'];
  const insUf = db.prepare('INSERT OR IGNORE INTO fiscal_aliquotas_uf (uf) VALUES (?)');
  db.transaction(() => { for (const uf of UFS) insUf.run(uf); })();

  // ─── Memória de cálculo ────────────────────────────────────────────────────
  // O equivalente da aba "Auditoria" do Solution: por que este imposto deu este
  // valor. Sem isto, discutir uma nota com o contador vira arqueologia.
  db.exec(`
    CREATE TABLE IF NOT EXISTS fiscal_calculo_memoria (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      documento TEXT NOT NULL,       -- 'fatura'
      documentoId INTEGER NOT NULL,
      itemId INTEGER,
      imposto TEXT NOT NULL,         -- 'ICMS' | 'ICMSST' | 'FCP' | 'IPI' | 'PIS' | 'COFINS'
      origem TEXT NOT NULL,          -- 'CALCULADO' | 'MANUAL' | 'ESPELHO'
      regraId INTEGER,
      cst TEXT,
      base REAL,
      aliquota REAL,
      reducao REAL,
      valor REAL,
      formula TEXT,                  -- memória em texto, uma linha por passo
      dataHora TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_calc_memoria_doc
      ON fiscal_calculo_memoria(documento, documentoId, itemId);
  `);

  // ─── faturas: marca a origem do documento ──────────────────────────────────
  // 'avulsa' = nasceu da NF manual (sem pedido/OS/devolução). Serve de filtro na
  // lista e evita ter de inferir origem por eliminação de FKs nulas.
  alterSafe(db, "ALTER TABLE faturas ADD COLUMN origemDocumento TEXT");

  // ─── fatura_itens: tributação resolvida, gravada no item ───────────────────
  // Antes daqui o item guardava só ncm/cfop/origem e o imposto era remontado do
  // zero a cada emissão, a partir do cadastro do produto. Isso impede nota com
  // destaque manual e faz a nota mudar de conteúdo se o cadastro mudar depois.
  for (const col of [
    // ICMS próprio
    'cstIcms TEXT', 'csosnIcms TEXT', 'modBC INTEGER',
    'vBcIcms REAL', 'pIcms REAL', 'pRedBC REAL', 'vIcms REAL',
    'pFcp REAL', 'vFcp REAL', 'pDif REAL', 'vIcmsDif REAL', 'motDesIcms INTEGER',
    // ICMS ST
    'modBCST INTEGER', 'vBcST REAL', 'pMVAST REAL', 'pRedBCST REAL',
    'pIcmsST REAL', 'vIcmsST REAL', 'pFcpST REAL', 'vFcpST REAL',
    // IPI
    'cstIpi TEXT', 'pIpi REAL', 'vIpi REAL',
    // PIS / COFINS
    'cstPis TEXT', 'pPis REAL', 'vPis REAL',
    'cstCofins TEXT', 'pCofins REAL', 'vCofins REAL',
    // DIFAL — partilha da EC 87/2015 (venda interestadual a não-contribuinte)
    'vBcUFDest REAL', 'pIcmsUFDest REAL', 'pIcmsInter REAL',
    'vIcmsUFDest REAL', 'vIcmsUFRemet REAL', 'pFcpUFDest REAL', 'vFcpUFDest REAL',
    // Benefício fiscal e CEST — ambos vivem no grupo <prod> do XML
    'codBenef TEXT', 'cest TEXT',
    // Procedência do cálculo e texto fiscal do item
    'tributacaoOrigem TEXT',   // 'CALCULADO' | 'MANUAL' | 'ESPELHO'
    'regraTribId INTEGER',
    'infAdProd TEXT',          // texto fiscal por item (lote, validade, ONU…)
  ]) {
    alterSafe(db, `ALTER TABLE fatura_itens ADD COLUMN ${col}`);
  }

  // ─── faturas.pedidoId precisa ser NULLABLE ─────────────────────────────────
  // A NF manual não tem pedido, igual à devolução de compra. O rebuild já existia
  // em devolucao-compra.js, mas era chamado DENTRO da rota de devolução — ou seja,
  // só migrava o tenant que usasse a funcionalidade. Em 2026-08-25, de 11 tenants,
  // só o `1bit` tinha a coluna nulável. Aqui ele passa a rodar no schema, para
  // todos. É idempotente (sai na hora se já for nulável) e tem guarda de contagem.
  try {
    require('./devolucao-compra').tornarPedidoIdNulavel(db);
  } catch (err) {
    console.warn('[fiscal-trib-schema] tornarPedidoIdNulavel:', err.message);
  }

  // tipoDevolucao vive no migrar() de devolucao-compra, que é no-op em multi-tenant.
  // Espelhado aqui pelo mesmo motivo dos blocos acima.
  alterSafe(db, "ALTER TABLE faturas ADD COLUMN tipoDevolucao TEXT");
  alterSafe(db, "ALTER TABLE faturas ADD COLUMN nfeEntradaId INTEGER");
  alterSafe(db, "ALTER TABLE fatura_itens ADD COLUMN nfeEntradaItemId INTEGER");
}

module.exports = { initFiscalTribSchema };
