// Define os modulos e limites de cada TIER de plano (starter/profissional/avancado/enterprise).
// Tier e armazenado em `tenants.plan` (TEXT). A periodicidade fica em `tenants.plano_id` (FK planos).
// Esta tabela e fonte de verdade para o middleware de feature-gate (Fase 2).
//
// Slugs de modulo: identificadores canonicos usados pelas rotas que precisam ser bloqueadas.
// Adicione novos slugs aqui e referencie-os no module-gate.js da Fase 2.

const MODULE_SLUGS = [
  'licitacoes',                  // Busca PNCP, agenda de pregoes, grupos de palavras
  'operacional_basico',          // Propostas Comprasnet basicas
  'sniper',                      // Robo de lances automaticos
  'monitor_chat',                // Monitor chat do pregoeiro
  'bi_basico',                   // Inteligencia de precos: consulta + agregados estatisticos
  'bi_ia',                       // Botao Analise IA (BYOAI - tenant conecta sua propria chave)
  'comercial',                   // CRM, Pedidos, Funil, Clientes/Fornecedores, Devolucoes
  'contratos_os',                // Contratos com recorrencia + Ordens de Servico + Portal Cliente
  'produtos_estoque_basico',     // Catalogo simples (sem lotes/serial/inventario)
  'produtos_estoque_completo',   // Estoque com lotes/serial, inventario fisico, produto lookup
  'compras',                     // Modulo de compras (cotacao, pedido de compra, recebimento)
  'varejo',                      // PDV (NFC-e), TEF, marketplaces (ML/Shopee), romaneios
  'fiscal_nfse_basico',          // NFS-e com limite mensal (cota definida em limites.nfse_mes_max)
  'fiscal_nfe_completo',         // NF-e 4.00, NFC-e, MDF-e, CT-e
  'fiscal_apuracao',             // Apuracao SN, DRE, DEFIS, arquivamento
  'fiscal_classificacao',        // Add-on: classificacao NCM/CEST + sugestao por IA (BYOAI). Atribuir a tier(s) e definir preco.
  'financeiro_basico',           // CR/CP, plano de contas, fluxo de caixa, livro caixa
  'financeiro_conciliacao',      // Conciliacao bancaria OFX
  'financeiro_avancado',         // Adiantamentos, renegociacao de titulos, incobraveis
  'contabilidade',               // Partida dobrada: plano contabil, lancamentos, diario/razao/balancete
  'governanca',                  // Alcadas e aprovacoes (pagamentos, pedidos de compra)
  'cobranca_automatica',         // Cobranca recorrente via Asaas
  'rh',                          // Funcionarios, comissoes, patrimonio
  'comunicacao',                 // Envio para clientes/fornecedores, log de e-mails, auditoria
  'otica',                       // Vertical: armacoes, lentes, receitas, ordens de montagem
  'api_rest_externa',            // API REST para integracoes externas
  'sso',                         // SSO via LDAP/SAML
];
const MODULE_SLUG_SET = new Set(MODULE_SLUGS);

const PLAN_TIERS = ['starter', 'profissional', 'avancado', 'enterprise'];

// Matriz definitiva acordada com Carlos em 2026-05-21.
const PLAN_MATRIX = {
  starter: {
    modules: [
      'licitacoes',
      'operacional_basico',
      'bi_basico',
      'bi_ia',                     // BYOAI - sem custo para a 1bit
      'comercial',
      'produtos_estoque_basico',
      'fiscal_nfse_basico',
      'financeiro_basico',
    ],
    limites: {
      usuarios_max: 1,
      cnpjs_max: 1,
      nfse_mes_max: 50,
    },
  },
  profissional: {
    modules: [
      'licitacoes',
      'operacional_basico',
      'sniper',
      'monitor_chat',
      'bi_basico',
      'bi_ia',
      'comercial',
      'contratos_os',
      'produtos_estoque_basico',
      'produtos_estoque_completo',
      'compras',
      'fiscal_nfse_basico',
      'financeiro_basico',
      'cobranca_automatica',
      'comunicacao',
    ],
    limites: {
      usuarios_max: 5,
      cnpjs_max: 1,
      nfse_mes_max: 200,
    },
  },
  avancado: {
    modules: [
      'licitacoes',
      'operacional_basico',
      'sniper',
      'monitor_chat',
      'bi_basico',
      'bi_ia',
      'comercial',
      'contratos_os',
      'produtos_estoque_basico',
      'produtos_estoque_completo',
      'compras',
      'varejo',
      'fiscal_nfse_basico',
      'fiscal_nfe_completo',
      'fiscal_apuracao',
      'financeiro_basico',
      'financeiro_conciliacao',
      'financeiro_avancado',
      'contabilidade',
      'cobranca_automatica',
      'rh',
      'comunicacao',
      'api_rest_externa',
    ],
    limites: {
      usuarios_max: 15,
      cnpjs_max: 3,
      nfse_mes_max: null,    // ilimitado
    },
  },
  enterprise: {
    modules: [
      'licitacoes',
      'operacional_basico',
      'sniper',
      'monitor_chat',
      'bi_basico',
      'bi_ia',
      'comercial',
      'contratos_os',
      'produtos_estoque_basico',
      'produtos_estoque_completo',
      'compras',
      'varejo',
      'fiscal_nfse_basico',
      'fiscal_nfe_completo',
      'fiscal_apuracao',
      'financeiro_basico',
      'financeiro_conciliacao',
      'financeiro_avancado',
      'contabilidade',
      'cobranca_automatica',
      'rh',
      'comunicacao',
      'otica',                   // vertical disponivel sob consulta
      'api_rest_externa',
      'sso',
      'governanca',
    ],
    limites: {
      usuarios_max: null,
      cnpjs_max: null,
      nfse_mes_max: null,
    },
  },
};

function ensurePlanModulesSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS plan_modules (
      tier        TEXT PRIMARY KEY,
      modules     TEXT NOT NULL,
      limites     TEXT NOT NULL,
      updated_at  INTEGER NOT NULL
    )
  `);

  const upsert = db.prepare(`
    INSERT INTO plan_modules (tier, modules, limites, updated_at)
    VALUES (@tier, @modules, @limites, @updated_at)
    ON CONFLICT(tier) DO UPDATE SET
      modules    = excluded.modules,
      limites    = excluded.limites,
      updated_at = excluded.updated_at
  `);

  const now = Date.now();
  const tx = db.transaction(() => {
    for (const tier of PLAN_TIERS) {
      const def = PLAN_MATRIX[tier];
      // Sanity check: nenhum slug bobo
      for (const m of def.modules) {
        if (!MODULE_SLUG_SET.has(m)) {
          throw new Error(`plan-modules: slug invalido "${m}" no tier ${tier}`);
        }
      }
      upsert.run({
        tier,
        modules: JSON.stringify(def.modules),
        limites: JSON.stringify(def.limites),
        updated_at: now,
      });
    }
  });
  tx();
}

function getPlanModules(db, tier) {
  if (!tier) return null;
  const row = db.prepare('SELECT modules, limites FROM plan_modules WHERE tier = ?').get(tier);
  if (!row) return null;
  return {
    tier,
    modules: JSON.parse(row.modules),
    limites: JSON.parse(row.limites),
  };
}

function listPlanModules(db) {
  const rows = db.prepare('SELECT tier, modules, limites, updated_at FROM plan_modules ORDER BY tier').all();
  return rows.map(r => ({
    tier: r.tier,
    modules: JSON.parse(r.modules),
    limites: JSON.parse(r.limites),
    updatedAt: r.updated_at,
  }));
}

module.exports = {
  MODULE_SLUGS,
  PLAN_TIERS,
  PLAN_MATRIX,
  ensurePlanModulesSchema,
  getPlanModules,
  listPlanModules,
};
